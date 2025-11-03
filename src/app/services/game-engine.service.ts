import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import { Team, Player, GameEvent } from './team.service';
import { environment } from '../../environments/environment';

export interface GameState {
  isRunning: boolean;
  timeRemaining: number;
  score: { team1: number; team2: number };
  ball: { x: number; y: number; vx: number; vy: number };
  events: GameEvent[];
  currentBallOwner: string | null;
  phase: 'pregame' | 'kickoff' | 'inplay' | 'finished';
  kickoffTeamName?: string | null;
}

@Injectable({ providedIn: 'root' })
export class GameEngineService {
  // ---------- Reactive state ----------
  private gameState$ = new BehaviorSubject<GameState>({
    isRunning: false,
    timeRemaining: 0,
    score: { team1: 0, team2: 0 },
    ball: {
      x: environment.gameSettings.fieldWidth / 2,
      y: environment.gameSettings.fieldHeight / 2,
      vx: 0,
      vy: 0,
    },
    events: [],
    currentBallOwner: null,
    phase: 'pregame',
    kickoffTeamName: null,
  });
  private gameEvents$ = new Subject<GameEvent>();

  // ---------- Loop & timers ----------
  private animationFrameId: number | null = null;
  private gameTimer: any | null = null;
  private lastTime = 0;
  private lastDecisionTime = 0;

  // ---------- Game State ----------
  private team1: Team | null = null;
  private team2: Team | null = null;
  private gameDuration = environment.gameSettings.defaultGameDuration;
  private rngState = 1;

  // ---------- Public streams ----------
  getGameState(): Observable<GameState> {
    return this.gameState$.asObservable();
  }

  getGameEvents(): Observable<GameEvent> {
    return this.gameEvents$.asObservable();
  }

  // -------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------
  startGame(team1: Team, team2: Team, duration: number = this.gameDuration): void {
    // Initialize teams and game state
    this.team1 = this.cloneTeam(team1);
    this.team2 = this.cloneTeam(team2);
    this.gameDuration = duration;
    this.ensureDistinctTeamColors();
    this.initializePlayerPositions();
    this.seedRng(team1, team2, duration);

    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;

    this.gameState$.next({
      isRunning: false,
      timeRemaining: duration,
      score: { team1: 0, team2: 0 },
      ball: { x: fieldWidth / 2, y: fieldHeight / 2, vx: 0, vy: 0 },
      events: [],
      currentBallOwner: null,
      phase: 'pregame',
      kickoffTeamName: null,
    });

    // Handle coin toss and kickoff
    const coinWinner = this.rand() < 0.5 ? this.team1! : this.team2!;
    this.gameState$.next({ ...this.gameState$.value, kickoffTeamName: coinWinner.name });
    this.emitEvent('coin_toss', coinWinner.name, 'Referee');

    const kickoffPlayer = this.findKickoffPlayer(coinWinner, fieldWidth, fieldHeight);
    if (kickoffPlayer) {
      kickoffPlayer.position.x = fieldWidth / 2 - (this.team1 === coinWinner ? 8 : -8);
      kickoffPlayer.position.y = fieldHeight / 2;
      this.gameState$.next({
        ...this.gameState$.value,
        currentBallOwner: kickoffPlayer.id,
        phase: 'kickoff',
      });
    }

    this.lastTime = Date.now();
    this.lastDecisionTime = this.lastTime;

    this.startGameLoop();

    setTimeout(() => {
      const gs = this.gameState$.value;
      if (gs.phase === 'kickoff' && kickoffPlayer) {
        this.emitEvent('kickoff', coinWinner.name, kickoffPlayer.name);
        this.gameState$.next({ ...gs, isRunning: true, phase: 'inplay' });
        this.startGameTimer();
      }
    }, 1000);
  }

  stopGame(): void {
    const gs = this.gameState$.value;
    if (!gs.isRunning) return;
    this.gameState$.next({ ...gs, isRunning: false });
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.gameTimer) clearInterval(this.gameTimer);
  }

  // -------------------------------------------------
  // Timers & loop
  // -------------------------------------------------
  private startGameLoop(): void {
    const loop = () => {
      const gs = this.gameState$.value;
      const now = Date.now();
      const delta = now - this.lastTime;
      this.lastTime = now;

      if (gs.isRunning && gs.phase === 'inplay') {
        this.updateBall(delta);
        if (now - this.lastDecisionTime >= environment.gameSettings.decisionIntervalMs) {
          this.lastDecisionTime = now;
          this.updatePlayerPositions(delta);
          this.handleGameEvents();
        }
      }

      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  private startGameTimer(): void {
    if (this.gameTimer) clearInterval(this.gameTimer);
    this.gameTimer = setInterval(() => {
      const gs = this.gameState$.value;
      if (!gs.isRunning) return;

      if (gs.timeRemaining <= 0) {
        this.gameState$.next({ ...gs, isRunning: false, phase: 'finished', timeRemaining: 0 });
        this.stopGame();
      } else {
        this.gameState$.next({ ...gs, timeRemaining: gs.timeRemaining - 1 });
      }
    }, 1000);
  }

  // -------------------------------------------------
  // Ball and Player Updates
  // -------------------------------------------------
  private updateBall(delta: number): void {
    const gs = this.gameState$.value;
    let { x, y, vx, vy } = gs.ball;

    if (gs.currentBallOwner) {
      const owner = this.findPlayer(gs.currentBallOwner);
      if (owner) {
        x = owner.position.x;
        y = owner.position.y;
        vx = 0;
        vy = 0;
      }
    } else {
      x += vx * delta;
      y += vy * delta;

      const friction = environment.gameSettings.speed.frictionFree;
      vx *= friction;
      vy *= friction;

      x = Math.max(0, Math.min(this.W, x));
      y = Math.max(0, Math.min(this.H, y));
    }

    this.gameState$.next({ ...gs, ball: { x, y, vx, vy } });
  }

  private updatePlayerPositions(delta: number): void {
    const gs = this.gameState$.value;
    const ball = gs.ball;
    const allPlayers = [...this.team1!.players, ...this.team2!.players];
    const baseSpeed = environment.gameSettings.speed.playerBase * (delta / 16.67);

    allPlayers.forEach((player) => {
      const dx = ball.x - player.position.x;
      const dy = ball.y - player.position.y;
      const distanceToBall = Math.hypot(dx, dy);

      const moveFactor = distanceToBall < 30 ? 1.5 : 0.5;
      const stepX = (dx / distanceToBall) * baseSpeed * moveFactor;
      const stepY = (dy / distanceToBall) * baseSpeed * moveFactor;

      player.position.x += stepX;
      player.position.y += stepY;

      player.position.x = Math.max(0, Math.min(this.W, player.position.x));
      player.position.y = Math.max(0, Math.min(this.H, player.position.y));
    });
  }

  // -------------------------------------------------
  // Game Events
  // -------------------------------------------------
  private emitEvent(type: string, teamName: string, playerName: string): void {
    const gs = this.gameState$.value;
    const elapsed = this.gameDuration - gs.timeRemaining;
    const displayTime = this.formatTime(elapsed);

    const event: GameEvent = {
      time: elapsed,
      type: type as any,
      team: teamName,
      player: playerName,
      description: this.describeEvent(type, playerName, teamName),
      displayTime,
      realMinute: Math.floor(elapsed / 60),
    };

    this.gameState$.next({ ...gs, events: [...gs.events, event] });
    this.gameEvents$.next(event);
  }

  private describeEvent(type: string, player: string, team: string): string {
    const eventDescriptions: Record<string, string> = {
      goal: `⚽ Goal! ${player} scores for ${team}!`,
      foul: `⚠️ Foul by ${player}.`,
      corner: `🚩 Corner for ${team}.`,
      offside: `🚨 Offside: ${player}.`,
      yellow_card: `🟨 Yellow card for ${player}.`,
      pass: `➡️ Pass by ${player}.`,
      shot: `🎯 Shot attempt by ${player}.`,
      tackle: `🛡️ Tackle won by ${player}.`,
    };

    return eventDescriptions[type] || `${player} performed an action.`;
  }

  private formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${secs}`;
  }

  // -------------------------------------------------
  // Utilities
  // -------------------------------------------------
  private cloneTeam(team: Team): Team {
    return {
      ...team,
      players: team.players.map((player) => ({
        ...player,
        position: { ...player.position },
      })),
    };
  }

  private seedRng(team1: Team, team2: Team, duration: number): void {
    const seed = team1.name + team2.name + duration.toString();
    let acc = 0x12345678;
    for (const char of seed) {
      acc = (acc ^ char.charCodeAt(0)) * 0x5bd1e995 + 1;
    }
    this.rngState = acc >>> 0 || 1;
  }

  private ensureDistinctTeamColors(): void {
    if (this.team1 && this.team2 && this.team1.color === this.team2.color) {
      // Change team2's color to a different color if they're the same
      const colors = ['#FF0000', '#0000FF', '#00FF00', '#FFFF00', '#FF00FF', '#00FFFF'];
      const currentColor = this.team1.color;
      const availableColors = colors.filter(color => color !== currentColor);
      this.team2.color = availableColors[0] || '#0000FF';
    }
  }

  private initializePlayerPositions(): void {
    // Initialize player positions for both teams
    if (this.team1) {
      this.setTeamFormation(this.team1, true);
    }
    if (this.team2) {
      this.setTeamFormation(this.team2, false);
    }
  }

  private setTeamFormation(team: Team, isLeftSide: boolean): void {
    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;
    const formation = [
      { x: isLeftSide ? fieldWidth * 0.1 : fieldWidth * 0.9, y: fieldHeight * 0.5 }, // Goalkeeper
      { x: isLeftSide ? fieldWidth * 0.25 : fieldWidth * 0.75, y: fieldHeight * 0.3 }, // Defender 1
      { x: isLeftSide ? fieldWidth * 0.25 : fieldWidth * 0.75, y: fieldHeight * 0.7 }, // Defender 2
      { x: isLeftSide ? fieldWidth * 0.4 : fieldWidth * 0.6, y: fieldHeight * 0.5 }, // Midfielder
      { x: isLeftSide ? fieldWidth * 0.6 : fieldWidth * 0.4, y: fieldHeight * 0.4 }, // Forward 1
      { x: isLeftSide ? fieldWidth * 0.6 : fieldWidth * 0.4, y: fieldHeight * 0.6 }, // Forward 2
    ];

    team.players.forEach((player, index) => {
      if (formation[index]) {
        player.position.x = formation[index].x;
        player.position.y = formation[index].y;
      }
    });
  }

  private findKickoffPlayer(team: Team, fieldWidth: number, fieldHeight: number): Player | null {
    return team.players.find(p => p.role === 'forward') || team.players[0] || null;
  }

  private findPlayer(playerId: string): Player | null {
    const allPlayers = [...(this.team1?.players || []), ...(this.team2?.players || [])];
    return allPlayers.find(p => p.id === playerId) || null;
  }

  private handleGameEvents(): void {
    // Basic game event handling logic
    const gs = this.gameState$.value;
    if (this.rand() < 0.01) { // 1% chance per decision interval
      const randomTeam = this.rand() < 0.5 ? this.team1 : this.team2;
      const randomPlayer = randomTeam?.players[Math.floor(this.rand() * randomTeam.players.length)];
      if (randomPlayer) {
        this.emitEvent('pass', randomTeam!.name, randomPlayer.name);
      }
    }
  }

  private rand(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) % Math.pow(2, 32);
    return this.rngState / Math.pow(2, 32);
  }

  private get W(): number {
    return environment.gameSettings.fieldWidth;
  }

  private get H(): number {
    return environment.gameSettings.fieldHeight;
  }
}