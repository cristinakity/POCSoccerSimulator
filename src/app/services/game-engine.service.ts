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
  // --- Added advanced simulation state ---
  private pendingPass: {
    passer: Player; target: Player;
    startX: number; startY: number; endX: number; endY: number;
    startTime: number; duration: number; type: string; shot?: boolean; xg?: number;
  } | null = null;
  private lastPassTime = 0;
  private passCooldownMs = 1400;
  private momentumCounter = 0;
  private halfSwitched = false;
  // Kickoff / possession tracking additions
  private possessionLockOwner: string | null = null;
  private possessionLockUntil = 0;
  private possessionStartTime = 0;

  // Fouls & cards control
  private lastFoulTime = 0;
  private foulCooldownMs = 4000;
  // Restart grace (suppresses immediate tackles/offside after restarts)
  private restartGraceUntil = 0;
  // Track last shooter & last touch for restart attribution
  private lastShooter: Player | null = null;
  private lastTouchTeam: 'team1' | 'team2' | null = null;
  // Recent owners history (throw-in attribution)
  private recentOwners: string[] = [];


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
    // IMPORTANT: Use the original team object references so the component inputs reflect updated player positions.
    // Previously we deep-cloned teams; that prevented the canvas from seeing updated positions (stayed at 0,0).
    this.team1 = team1;
    this.team2 = team2;
    this.gameDuration = duration;
    this.ensureDistinctTeamColors();
  this.initializePlayerPositions();
    this.seedRng(team1, team2, duration);

    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;

  this.halfSwitched = false;
  this.pendingPass = null;
  this.lastPassTime = Date.now();
  this.possessionLockOwner = null;
  this.possessionLockUntil = 0;
  this.possessionStartTime = 0;
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
      // Lock initial possession briefly so immediate tackles don't steal kickoff
      this.possessionStartTime = Date.now();
      this.possessionLockOwner = kickoffPlayer.id;
      this.possessionLockUntil = Date.now() + 600;
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
          this.maybeGenerateFoul(now);
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
      // Halftime mirror once at midpoint
      if (!this.halfSwitched && gs.timeRemaining === Math.floor(this.gameDuration / 2)) {
        this.mirrorSides();
        this.halfSwitched = true;
        this.emitEvent('momentum', 'neutral', '', 'Teams switch sides (halftime).');
      }
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
    // Animated pass / shot in flight
    if (this.pendingPass) {
      const p = this.pendingPass;
      const t = Math.min(1, (Date.now() - p.startTime) / p.duration);
      x = p.startX + (p.endX - p.startX) * t;
      y = p.startY + (p.endY - p.startY) * t;
      // Rough velocity estimate
      vx = (p.endX - p.startX) / (p.duration / 1000);
      vy = (p.endY - p.startY) / (p.duration / 1000);
      if (t >= 1) {
        if (p.shot) {
          if (this.isGoal(x, y)) {
            this.scoreGoal(p.passer);
            this.pendingPass = null;
            return;
          } else {
            this.emitEvent('shot', this.teamOfPlayer(p.passer).name, p.passer.name);
          }
        }
        this.setBallOwner(p.target);
        this.pendingPass = null;
      }
      this.gameState$.next({ ...gs, ball: { x, y, vx, vy } });
      return;
    }

    if (gs.currentBallOwner) {
      const owner = this.findPlayer(gs.currentBallOwner);
      if (owner) { 
        x = owner.position.x; 
        y = owner.position.y; 
        vx = 0; 
        vy = 0; 
      }
      this.gameState$.next({ ...gs, ball: { x, y, vx, vy } });
    } else {
      const dtSec = delta / 1000;
      x += vx * dtSec; y += vy * dtSec;
      const friction = environment.gameSettings.speed.frictionFree;
      vx *= friction; vy *= friction;
      if (Math.abs(vx) < 0.02) vx = 0; if (Math.abs(vy) < 0.02) vy = 0;
      x = Math.max(0, Math.min(this.W, x));
      y = Math.max(0, Math.min(this.H, y));
      // Throw-in detection
      if (y <= 5 || y >= this.H - 5) { this.handleThrowIn(x, y); return; }
      // Goal / corner / goal kick logic
      const goalHalf = (environment.gameSettings.goalWidthM * (this.H / environment.gameSettings.pitchWidthM)) / 2;
      const inAperture = Math.abs(y - this.H / 2) <= goalHalf;
      const crossedLeft = x < 5; const crossedRight = x > this.W - 5;
      if (crossedLeft || crossedRight) {
        if (inAperture) {
          const scorer = gs.currentBallOwner ? this.findPlayer(gs.currentBallOwner) : this.lastShooter;
          if (scorer) { this.scoreGoal(scorer); }
          else {
            // Neutral goal event (e.g., ball crosses line without clear scorer)
            this.emitEvent('goal', 'neutral', '', undefined, { startX: x, startY: y, endX: x, endY: y, result: 'goal' });
            this.gameState$.next({ ...gs, ball: { x: this.W / 2, y: this.H / 2, vx: 0, vy: 0 }, currentBallOwner: null });
          }
          this.restartGraceUntil = Date.now() + 1500;
          return;
        } else {
          const attackingTeamIsTeam1 = crossedRight; // team1 attacks right
          const lastTouch = this.lastTouchTeam || (attackingTeamIsTeam1 ? 'team1' : 'team2');
          const isGoalKick = lastTouch === (attackingTeamIsTeam1 ? 'team1' : 'team2');
          if (isGoalKick) {
            this.performGoalKick(attackingTeamIsTeam1 ? 'team2' : 'team1', crossedLeft ? 'left' : 'right');
          } else {
            this.performCorner(attackingTeamIsTeam1 ? this.team1! : this.team2!, crossedLeft ? 'left' : 'right', y < this.H / 2 ? 'top' : 'bottom');
          }
          this.restartGraceUntil = Date.now() + 1500;
          return;
        }
      }
      // Legacy simple goal fallback
      if (this.isGoal(x, y)) {
        // Fallback simple goal detection
        this.emitEvent('goal', 'neutral', '', undefined, { startX: x, startY: y, endX: x, endY: y, result: 'goal' });
        this.gameState$.next({ ...gs, ball: { x: this.W / 2, y: this.H / 2, vx: 0, vy: 0 }, currentBallOwner: null });
        this.restartGraceUntil = Date.now() + 1200;
        return;
      }
      this.gameState$.next({ ...gs, ball: { x, y, vx, vy } });
    }
  }

  private updatePlayerPositions(delta: number): void {
    const gs = this.gameState$.value;
    const ball = gs.ball;
    const allPlayers = [...this.team1!.players, ...this.team2!.players];
    const baseSpeed = environment.gameSettings.speed.playerBase * (delta / 16.67);
    const ballOwner = gs.currentBallOwner ? this.findPlayer(gs.currentBallOwner) : null;
    const ownerIsTeam1 = ballOwner ? this.isTeam1(ballOwner) : null;
    const attackingTeam = ownerIsTeam1 == null ? null : (ownerIsTeam1 ? this.team1! : this.team2!);
    const defendingTeam = ownerIsTeam1 == null ? null : (ownerIsTeam1 ? this.team2! : this.team1!);

    // Pressers: when ball is owned, limit to 2 defenders; when loose, pick closest 3 from all players
    let pressers: Player[] = [];
    if (ballOwner && defendingTeam) {
      pressers = defendingTeam.players.filter(p => p.role !== 'goalkeeper')
        .map(p => ({ p, d: Math.hypot(p.position.x - ball.x, p.position.y - ball.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
        .map(o => o.p);
    } else if (!ballOwner) {
      // Loose ball: closest 3 players from both teams chase
      pressers = allPlayers.filter(p => p.role !== 'goalkeeper')
        .map(p => ({ p, d: Math.hypot(p.position.x - ball.x, p.position.y - ball.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map(o => o.p);
    }

    // Support runner (closest non-owner attacker)
    let support: Player | null = null;
    if (attackingTeam && ballOwner) {
      support = attackingTeam.players.filter(p => p.id !== ballOwner.id && p.role !== 'goalkeeper')
        .sort((a, b) => Math.hypot(a.position.x - ball.x, a.position.y - ball.y) - Math.hypot(b.position.x - ball.x, b.position.y - ball.y))[0] || null;
    }

    allPlayers.forEach(p => {
      const isOwner = !!ballOwner && p.id === ballOwner.id;
      const dir = this.isTeam1(p) ? 1 : -1;
      const basePos = (p as any).basePosition || { x: p.position.x, y: p.position.y };
      if (isOwner) {
        // Dribbler: smooth forward advance with minimal lateral noise
        const staminaFactor = p.abilities?.stamina && p.abilities?.maxStamina ? Math.max(0.6, p.abilities.stamina / p.abilities.maxStamina) : 1;
        const speedFactor = Math.min(1.2, (p.abilities?.speedFactor ?? 1) * staminaFactor);
        p.position.x += dir * baseSpeed * 0.4 * speedFactor;
        p.position.y += (this.rand() - 0.5) * baseSpeed * 0.15;
      } else if (pressers.includes(p)) {
        // Pressers: smooth approach, capped speed
        const dx = ball.x - p.position.x; const dy = ball.y - p.position.y; const d = Math.hypot(dx, dy) || 1;
        const pressSpeed = Math.min(baseSpeed * 1.1, baseSpeed * 0.9 * (p.abilities?.speedFactor ?? 1));
        const moveX = (dx / d) * pressSpeed; const moveY = (dy / d) * pressSpeed;
        p.position.x += moveX * 0.7; p.position.y += moveY * 0.7;
      } else if (support && p.id === support.id) {
        // Support runner: smooth offset toward space near ball
        const offsetX = (ball.x - basePos.x) * 0.20;
        const offsetY = (ball.y - basePos.y) * 0.25;
        const targetX = basePos.x + offsetX; const targetY = basePos.y + offsetY;
        const dx = targetX - p.position.x; const dy = targetY - p.position.y; const d = Math.hypot(dx, dy) || 1;
        if (d > 3) {
          p.position.x += (dx / d) * baseSpeed * 0.5; p.position.y += (dy / d) * baseSpeed * 0.5;
        }
      } else {
        // Shape holders: gentle drift toward formation position with contextual shift
        let shiftX = (ball.x - this.W / 2) * 0.03 * dir;
        let shiftY = (ball.y - this.H / 2) * 0.05;
        if (ballOwner) {
          const sameSide = ownerIsTeam1 === this.isTeam1(p);
          if (sameSide) {
            const behindBall = (p.position.x * dir) < (ball.x * dir - 60);
            if (behindBall) shiftX += 12 * dir;
          } else {
            const aheadBall = (p.position.x * dir) > (ball.x * dir + 30);
            if (aheadBall) shiftX -= 10 * dir;
          }
        }
        const targetX = Math.max(0, Math.min(this.W, basePos.x + shiftX));
        const targetY = Math.max(0, Math.min(this.H, basePos.y + shiftY));
        const dx = targetX - p.position.x; const dy = targetY - p.position.y; const d = Math.hypot(dx, dy) || 1;
        if (d > 2) {
          p.position.x += (dx / d) * baseSpeed * 0.35; p.position.y += (dy / d) * baseSpeed * 0.35;
        }
      }
      p.position.x = Math.max(0, Math.min(this.W, p.position.x));
      p.position.y = Math.max(0, Math.min(this.H, p.position.y));
    });

    // Loose ball pickup: if no owner and a player is close enough, give possession
    if (!ballOwner) {
      for (const p of allPlayers) {
        const dist = Math.hypot(p.position.x - ball.x, p.position.y - ball.y);
        if (dist < 8) {
          this.setBallOwner(p);
          break;
        }
      }
    }

    // Separation pass to prevent overlapping
    for (let i = 0; i < allPlayers.length; i++) {
      for (let j = i + 1; j < allPlayers.length; j++) {
        const a = allPlayers[i]; const b = allPlayers[j];
        let dx = b.position.x - a.position.x; let dy = b.position.y - a.position.y; const dist = Math.hypot(dx, dy);
        if (dist > 0 && dist < 12) {
          const push = (12 - dist) * 0.3; dx /= dist; dy /= dist;
          a.position.x -= dx * push; a.position.y -= dy * push;
          b.position.x += dx * push; b.position.y += dy * push;
          a.position.x = Math.max(0, Math.min(this.W, a.position.x)); a.position.y = Math.max(0, Math.min(this.H, a.position.y));
          b.position.x = Math.max(0, Math.min(this.W, b.position.x)); b.position.y = Math.max(0, Math.min(this.H, b.position.y));
        }
      }
    }
  }

  // -------------------------------------------------
  // Game Events
  // -------------------------------------------------
  private emitEvent(type: string, teamName: string, playerName: string, descriptionOverride?: string, extra?: Partial<GameEvent>): void {
    const gs = this.gameState$.value;
    const elapsed = this.gameDuration - gs.timeRemaining;
    const displayTime = this.formatTime(elapsed);
    const zone = (x?: number, y?: number): string | undefined => {
      if (x == null || y == null) return undefined;
      const third = this.W / 3;
      let z = 'middle_third';
      if (x < third) z = 'defensive_third'; else if (x > 2 * third) z = 'attacking_third';
      const flank = this.H * 0.20;
      if (y < flank) z += '_top_flank'; else if (y > this.H - flank) z += '_bottom_flank'; else z += '_central';
      return z;
    };
    const event: GameEvent = {
      time: elapsed,
      type: type as any,
      team: teamName,
      player: playerName,
      description: descriptionOverride || this.describeEvent(type, playerName, teamName),
      displayTime,
      realMinute: Math.floor(elapsed / 60),
      startX: extra?.startX,
      startY: extra?.startY,
      endX: extra?.endX,
      endY: extra?.endY,
      result: extra?.result,
      role: extra?.role,
      subtype: extra?.subtype,
      xg: extra?.xg,
      pressure: extra?.pressure,
      facingError: extra?.facingError,
      zoneStart: zone(extra?.startX, extra?.startY),
      zoneEnd: zone(extra?.endX, extra?.endY)
    };
    if (['pass','shot'].includes(type)) this.momentumCounter = Math.min(100, this.momentumCounter + (type === 'shot' ? 4 : 1));
    if (type === 'goal') this.momentumCounter = 0;
    (event as any).momentumIndex = this.momentumCounter;
    this.gameState$.next({ ...gs, events: [...gs.events, event] });
    this.gameEvents$.next(event);
  }

  private describeEvent(type: string, player: string, team: string): string {
    const eventDescriptions: Record<string, string> = {
      goal: `⚽ Goal! ${player} scores for ${team}!`,
      foul: `⚠️ Foul by ${player}.`,
      corner: `🚩 Corner for ${team}.`,
      offside: `🚨 Offside: ${player}.`,
      yellow_card: `🟨 Yellow card to ${player}.`,
      pass: `➡️ Pass by ${player}.`,
      shot: `🎯 Shot attempt by ${player}.`,
      tackle: `🛡️ Tackle won by ${player}.`,
      interception: `✂️ Interception by ${player}.`,
      momentum: `Momentum shift in match.`,
      goal_kick: `🧤 Goal kick by ${player}.`
      ,coin_toss: `🪙 Coin toss: ${team} to kick off.`,
      kickoff: `🔔 Kickoff by ${player} (${team}).`,
      throw_in: `↔️ Throw-in: ${player}.`,
      penalty: `⚠️ Penalty awarded – ${player}.`,
      save: `🧱 Save by ${player}!`
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
    if (!this.team1 || !this.team2) return;
    const formations = [
      { name: '4-3-3_standard', defX: 0.25, midX: 0.48, fwdX: 0.72, defSpread: 0.50, midSpread: 0.60, fwdSpread: 0.55 },
      { name: '4-4-2_shape', defX: 0.24, midX: 0.50, fwdX: 0.70, defSpread: 0.52, midSpread: 0.65, fwdSpread: 0.42 },
      { name: '3-5-2_compact', defX: 0.22, midX: 0.50, fwdX: 0.72, defSpread: 0.60, midSpread: 0.70, fwdSpread: 0.38 },
      { name: '5-3-2_block', defX: 0.20, midX: 0.46, fwdX: 0.68, defSpread: 0.56, midSpread: 0.55, fwdSpread: 0.34 }
    ];
    const pick = () => formations[Math.floor(this.rand() * formations.length)];
    const placeTeam = (team: Team, left: boolean) => {
      const W = environment.gameSettings.fieldWidth;
      const H = environment.gameSettings.fieldHeight;
      const f = pick();
      const gk = team.players.filter(p => p.role === 'goalkeeper');
      const defs = team.players.filter(p => p.role === 'defender');
      const mids = team.players.filter(p => p.role === 'midfielder');
      const fwds = team.players.filter(p => p.role === 'forward');
      const assignLine = (arr: Player[], depth: number, spread: number) => {
        const cx = depth * W;
        arr.forEach((p, i) => {
          const rel = arr.length === 1 ? 0 : (i / (arr.length - 1) - 0.5);
          const y = H / 2 + rel * spread * H * 0.5 + (this.rand() - 0.5) * 18;
          p.position.x = (left ? cx : W - cx) + (this.rand() - 0.5) * 16;
          p.position.y = Math.max(30, Math.min(H - 30, y));
        });
      };
      gk.forEach(p => { p.position.x = left ? W * 0.06 : W - W * 0.06; p.position.y = H / 2 + (this.rand() - 0.5) * 30; });
      assignLine(defs, f.defX, f.defSpread);
      assignLine(mids, f.midX, f.midSpread);
      assignLine(fwds, f.fwdX, f.fwdSpread);
      const mid = W / 2;
      team.players.forEach(p => {
        if (left && p.position.x > mid - 12) p.position.x = mid - 12;
        if (!left && p.position.x < mid + 12) p.position.x = mid + 12;
      });
    };
    placeTeam(this.team1, true);
    placeTeam(this.team2, false);
    [...this.team1.players, ...this.team2.players].forEach(p => { (p as any).basePosition = { x: p.position.x, y: p.position.y }; });
  }

  /** Expose current mutable team references (used by UI if needed) */
  getTeams(): { team1: Team | null; team2: Team | null } {
    return { team1: this.team1, team2: this.team2 };
  }

  private findKickoffPlayer(team: Team, fieldWidth: number, fieldHeight: number): Player | null {
    return team.players.find(p => p.role === 'forward') || team.players[0] || null;
  }

  private findPlayer(playerId: string): Player | null {
    const allPlayers = [...(this.team1?.players || []), ...(this.team2?.players || [])];
    return allPlayers.find(p => p.id === playerId) || null;
  }

  private handleGameEvents(): void {
    const gs = this.gameState$.value;
    if (!gs.currentBallOwner || this.pendingPass) return;
    const owner = this.findPlayer(gs.currentBallOwner);
    if (!owner) return;
    const dir = this.isTeam1(owner) ? 1 : -1;
    const team = this.isTeam1(owner) ? this.team1! : this.team2!;
    const mates = team.players.filter(p => p.id !== owner.id);
    if (!mates.length) return;
    
    // Shooting chance when in attacking position
    const goalX = dir === 1 ? this.W - 6 : 6;
    const distToGoal = Math.abs(goalX - owner.position.x);
    const centerY = this.H / 2;
    const yOffset = Math.abs(owner.position.y - centerY);
    
    // More aggressive shooting: closer = higher probability, better angles = higher probability
    let shootChance = 0;
    if (distToGoal < 200 && yOffset < 180) {
      // Base chance increases as player gets closer and more central
      shootChance = 0.08 + (200 - distToGoal) / 2000 + (180 - yOffset) / 3600;
      // Forwards shoot more often
      if (owner.role === 'forward') shootChance *= 1.5;
    }
    
    if (shootChance > 0 && this.rand() < shootChance) {
      this.takeShot(owner, goalX, centerY);
      return;
    }
    
    // Pass decision respecting cooldown
    const now = Date.now();
    if (now - this.lastPassTime < this.passCooldownMs) return;
    this.lastPassTime = now;
    const forward: Player[] = []; const lateral: Player[] = []; const back: Player[] = [];
    mates.forEach(m => {
      const dx = (m.position.x - owner.position.x) * dir;
      if (dx > 40) forward.push(m); else if (Math.abs(dx) <= 40) lateral.push(m); else back.push(m);
    });
    const candidate = (forward.length ? this.shuffle(forward)[0] : (lateral.length ? this.shuffle(lateral)[0] : this.shuffle(back)[0]));
    if (!candidate) return;
    this.initiatePass(owner, candidate);
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

  // -------------------------------------------------
  // Advanced helpers (passes, shots, offside, goals)
  // -------------------------------------------------
  private initiatePass(passer: Player, target: Player): void {
    const startX = passer.position.x; const startY = passer.position.y;
    const endX = target.position.x; const endY = target.position.y;
    const dist = Math.hypot(endX - startX, endY - startY);
    const speed = environment.gameSettings.speed.passSpeed;
    const duration = Math.max(200, (dist / speed) * 1000);
    // Interception pre-check
    const opponents = this.isTeam1(passer) ? this.team2!.players : this.team1!.players;
    const arrivalTime = dist / speed;
    const interceptor = this.findInterceptor(startX, startY, endX, endY, opponents, arrivalTime, environment.gameSettings.speed.playerBase);
    if (interceptor && Date.now() > this.restartGraceUntil) {
      this.emitEvent('interception', this.teamOfPlayer(interceptor).name, interceptor.name, undefined, { startX, startY, endX: interceptor.position.x, endY: interceptor.position.y, result: 'intercepted', subtype: 'interception', role: interceptor.role });
      this.setBallOwner(interceptor);
      this.lastTouchTeam = this.isTeam1(interceptor) ? 'team1' : 'team2';
      return;
    }
    this.pendingPass = {
      passer, target, startX, startY, endX, endY,
      startTime: Date.now(), duration,
      type: this.classifyPassType(passer, target)
    };
    this.gameState$.next({ ...this.gameState$.value, currentBallOwner: null });
    this.emitEvent('pass', this.teamOfPlayer(passer).name, passer.name, undefined, { startX, startY, endX, endY, subtype: this.classifyPassType(passer, target), result: 'attempt', role: passer.role });
    this.checkOffsideOnPass(passer, target);
    this.lastTouchTeam = this.isTeam1(passer) ? 'team1' : 'team2';
  }

  private takeShot(shooter: Player, goalX: number, goalY: number): void {
    const startX = shooter.position.x; const startY = shooter.position.y;
    const endX = goalX + (this.rand() - 0.5) * 30; const endY = goalY + (this.rand() - 0.5) * 50;
    const dist = Math.hypot(endX - startX, endY - startY);
    const speed = environment.gameSettings.speed.shotSpeed;
    const duration = Math.max(180, (dist / speed) * 1000);
    const xg = this.estimateSimpleXG(dist);
    this.pendingPass = { passer: shooter, target: shooter, startX, startY, endX, endY, startTime: Date.now(), duration, type: 'shot', shot: true, xg };
    this.gameState$.next({ ...this.gameState$.value, currentBallOwner: null });
    this.emitEvent('shot', this.teamOfPlayer(shooter).name, shooter.name, undefined, { startX, startY, endX, endY, xg, subtype: 'shot_attempt', result: 'attempt', role: shooter.role });
    this.lastShooter = shooter;
    this.lastTouchTeam = this.isTeam1(shooter) ? 'team1' : 'team2';
  }

  private classifyPassType(from: Player, to: Player): string {
    const d = Math.hypot(from.position.x - to.position.x, from.position.y - to.position.y);
    if (d < 120) return 'short_pass'; if (d < 260) return 'medium_pass'; return 'long_pass';
  }
  private estimateSimpleXG(distance: number): number {
    const scale = environment.gameSettings.xgTuning?.distanceScale ?? 150;
    const v = 1 / (1 + Math.exp((distance - scale) / 85));
    return Math.min(0.95, Math.max(0.02, v));
  }

  private isGoal(x: number, y: number): boolean {
    const apertureHalf = (environment.gameSettings.goalWidthM * (this.H / environment.gameSettings.pitchWidthM)) / 2;
    if (y < this.H / 2 - apertureHalf || y > this.H / 2 + apertureHalf) return false;
    return x <= 4 || x >= this.W - 4;
  }

  private scoreGoal(scorer: Player): void {
    const gs = this.gameState$.value;
    const score = { ...gs.score };
    if (this.isTeam1(scorer)) score.team1++; else score.team2++;
    this.emitEvent('goal', this.teamOfPlayer(scorer).name, scorer.name, undefined, { startX: scorer.position.x, startY: scorer.position.y, endX: scorer.position.x, endY: scorer.position.y, result: 'goal', role: scorer.role });
    this.pendingPass = null;
    this.gameState$.next({ ...gs, score, ball: { x: this.W / 2, y: this.H / 2, vx: 0, vy: 0 }, currentBallOwner: null });
    this.restartGraceUntil = Date.now() + 1200;
  }

  private getSecondLastDefenderX(defenders: Player[], dir: number): number {
    if (!defenders.length) return dir === 1 ? 0 : this.W;
    const xs = defenders.map(d => d.position.x).sort((a, b) => a - b);
    return dir === 1 ? (xs[xs.length - 2] ?? xs[0]) : (xs[1] ?? xs[xs.length - 1]);
  }

  private checkOffsideOnPass(passer: Player, receiver: Player): void {
    const isTeam1Passer = this.isTeam1(passer);
    const defenders = (isTeam1Passer ? this.team2 : this.team1)?.players.filter(p => p.role !== 'goalkeeper') || [];
    const dir = isTeam1Passer ? 1 : -1;
    const secondLast = this.getSecondLastDefenderX(defenders, dir);
    const inOppHalf = isTeam1Passer ? receiver.position.x > this.W / 2 : receiver.position.x < this.W / 2;
    const aheadBall = isTeam1Passer ? receiver.position.x > passer.position.x : receiver.position.x < passer.position.x;
    const aheadDef = isTeam1Passer ? receiver.position.x > secondLast : receiver.position.x < secondLast;
    if (inOppHalf && aheadBall && aheadDef) {
      this.emitEvent('offside', this.teamOfPlayer(passer).name, receiver.name, undefined, { startX: passer.position.x, startY: passer.position.y, endX: receiver.position.x, endY: receiver.position.y, result: 'whistle', subtype: 'offside' });
      this.pendingPass = null;
      const restartX = passer.position.x - 30 * dir;
      const restartY = passer.position.y;
      const defendingTeam = isTeam1Passer ? this.team2! : this.team1!;
      const taker = defendingTeam.players.find(p => p.role === 'defender') || defendingTeam.players[0];
      this.gameState$.next({ ...this.gameState$.value, ball: { x: restartX, y: restartY, vx: 0, vy: 0 }, currentBallOwner: taker.id });
      this.restartGraceUntil = Date.now() + 1500;
    }
  }

  // ---------- Advanced helpers (restarts, interception, fouls) ----------
  private performCorner(team: Team, side: 'left' | 'right', quadrant: 'top' | 'bottom'): void {
    const W = this.W; const H = this.H;
    const x = side === 'left' ? 30 : W - 30;
    const y = quadrant === 'top' ? 30 : H - 30;
    let taker = team.players[0]; let best = Infinity;
    team.players.forEach(p => { const d = Math.hypot(p.position.x - x, p.position.y - y); if (d < best) { best = d; taker = p; } });
    this.gameState$.next({ ...this.gameState$.value, ball: { x, y, vx: 0, vy: 0 }, currentBallOwner: taker.id });
    this.emitEvent('corner', team.name, taker.name, undefined, { startX: x, startY: y, endX: x, endY: y, result: 'restart', subtype: 'corner_kick', role: taker.role });
    this.restartGraceUntil = Date.now() + 1200;
    this.lastTouchTeam = this.isTeam1(taker) ? 'team1' : 'team2';
  }

  private performGoalKick(defTeam: 'team1' | 'team2', side: 'left' | 'right'): void {
    const W = this.W; const H = this.H; const team = defTeam === 'team1' ? this.team1! : this.team2!;
    const x = side === 'left' ? 60 : W - 60; const y = H / 2 + (this.rand() - 0.5) * 80;
    const keeper = team.players.find(p => p.role === 'goalkeeper') || team.players[0];
    this.gameState$.next({ ...this.gameState$.value, ball: { x, y, vx: 0, vy: 0 }, currentBallOwner: keeper.id });
    this.emitEvent('goal_kick', team.name, keeper.name, undefined, { startX: x, startY: y, endX: x, endY: y, result: 'restart', subtype: 'goal_kick', role: keeper.role });
    this.restartGraceUntil = Date.now() + 1200;
    this.lastTouchTeam = defTeam;
  }

  private handleThrowIn(x: number, y: number): void {
    if (!this.team1 || !this.team2) return;
    const H = this.H; const W = this.W;
    const inY = y < H / 2 ? 30 : H - 30;
    const inX = Math.max(40, Math.min(W - 40, x));
    const lastId = this.recentOwners[this.recentOwners.length - 1];
    const all = [...this.team1.players, ...this.team2.players];
    const lastPlayer = all.find(p => p.id === lastId);
    const throwTeam = lastPlayer ? (this.team1.players.includes(lastPlayer) ? this.team2! : this.team1!) : this.team1!;
    let taker = throwTeam.players[0]; let best = Infinity;
    throwTeam.players.forEach(p => { const d = Math.hypot(p.position.x - inX, p.position.y - inY); if (d < best) { best = d; taker = p; } });
    this.gameState$.next({ ...this.gameState$.value, ball: { x: inX, y: inY, vx: 0, vy: 0 }, currentBallOwner: taker.id });
    this.emitEvent('throw_in', throwTeam.name, taker.name, undefined, { startX: inX, startY: inY, endX: inX, endY: inY, result: 'restart', subtype: 'throw_in', role: taker.role });
    this.restartGraceUntil = Date.now() + 1500;
  }

  private findInterceptor(x0: number, y0: number, x1: number, y1: number, opponents: Player[], ballArrival: number, baseSpeed: number): Player | null {
    let best: Player | null = null; let bestLead = Infinity;
    opponents.forEach(o => {
      const t = this.paramAlongSegment(o.position.x, o.position.y, x0, y0, x1, y1);
      const clamp = Math.max(0, Math.min(1, t));
      const px = x0 + (x1 - x0) * clamp; const py = y0 + (y1 - y0) * clamp;
      const corridorDist = Math.hypot(o.position.x - px, o.position.y - py);
      if (corridorDist > 40) return;
      const oppSpeed = baseSpeed * (o.abilities?.speedFactor ?? 1);
      const travel = corridorDist / (oppSpeed + 0.01);
      if (travel < ballArrival * 0.85 && travel < bestLead) { bestLead = travel; best = o; }
    });
    return best;
  }
  private paramAlongSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0; const dy = y1 - y0; const lenSq = dx * dx + dy * dy; if (!lenSq) return 0; return ((px - x0) * dx + (py - y0) * dy) / lenSq;
  }

  private maybeGenerateFoul(now: number): void {
    if (!this.team1 || !this.team2) return;
    if (now - this.lastFoulTime < this.foulCooldownMs) return;
    const everyone = [...this.team1.players, ...this.team2.players];
    const collisions: { offender: Player; team: Team }[] = [];
    for (let i = 0; i < everyone.length; i++) {
      for (let j = i + 1; j < everyone.length; j++) {
        const a = everyone[i]; const b = everyone[j];
        const sameTeam = (this.team1.players.includes(a) && this.team1.players.includes(b)) || (this.team2.players.includes(a) && this.team2.players.includes(b));
        if (sameTeam) continue;
        const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        if (d < 16) collisions.push({ offender: a, team: this.team1.players.includes(a) ? this.team1 : this.team2 });
      }
    }
    if (collisions.length && this.rand() < 0.15) {
      const pick = collisions[Math.floor(this.rand() * collisions.length)];
      const cardRoll = this.rand();
      const type = cardRoll > 0.93 ? 'yellow_card' : 'foul';
      this.emitEvent(type, pick.team.name, pick.offender.name, undefined, { startX: pick.offender.position.x, startY: pick.offender.position.y, endX: pick.offender.position.x, endY: pick.offender.position.y, result: 'whistle', subtype: type, role: pick.offender.role });
      this.lastFoulTime = now;
    }
  }

  private setBallOwner(player: Player): void {
    const gs = this.gameState$.value;
    this.gameState$.next({ ...gs, currentBallOwner: player.id });
  }

  private mirrorSides(): void {
    [...(this.team1?.players || []), ...(this.team2?.players || [])].forEach(p => {
      p.position.x = this.W - p.position.x;
      if ((p as any).basePosition) (p as any).basePosition.x = this.W - (p as any).basePosition.x;
    });
  }

  private isTeam1(p: Player): boolean { return !!this.team1 && this.team1.players.includes(p); }
  private teamOfPlayer(p: Player): Team { return this.isTeam1(p) ? this.team1! : this.team2!; }
  private shuffle<T>(arr: T[]): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}