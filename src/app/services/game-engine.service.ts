import { Injectable } from '@angular/core';
import { Subject, Observable, BehaviorSubject } from 'rxjs';
import { Team, Player, GameEvent } from './team.service';
import { environment } from '../../environments/environment';

export interface GameState {
  isRunning: boolean;
  timeRemaining: number;
  score: { team1: number; team2: number };
  ball: { x: number; y: number; vx: number; vy: number };
  events: GameEvent[];
  currentBallOwner: string | null; // player id of current possession
}

@Injectable({
  providedIn: 'root'
})
export class GameEngineService {
  private gameState$ = new BehaviorSubject<GameState>({
    isRunning: false,
    timeRemaining: 0,
    score: { team1: 0, team2: 0 },
    ball: { x: 450, y: 300, vx: 0, vy: 0 },
    events: [],
    currentBallOwner: null
  });

  private gameEvents$ = new Subject<GameEvent>();
  private animationFrameId: number | null = null;
  private gameTimer: number | null = null;
  private lastTime = 0;
  private lastPassTime = 0; // ms timestamp of last pass
  private passCooldown = 2500; // ms between passes

  private team1: Team | null = null;
  private team2: Team | null = null;
  private gameDuration = environment.gameSettings.defaultGameDuration;

  getGameState(): Observable<GameState> {
    return this.gameState$.asObservable();
  }

  getGameEvents(): Observable<GameEvent> {
    return this.gameEvents$.asObservable();
  }

  startGame(team1: Team, team2: Team, duration: number = this.gameDuration): void {
    this.team1 = team1;
    this.team2 = team2;
    this.gameDuration = duration;

    // Ensure visibly distinct colors between the two selected teams
    this.ensureDistinctTeamColors();

    // Initialize player positions
    this.initializePlayerPositions();

    // Reset game state
    const initialState: GameState = {
      isRunning: true,
      timeRemaining: duration,
      score: { team1: 0, team2: 0 },
      ball: { x: 450, y: 300, vx: Math.random() * 4 - 2, vy: Math.random() * 4 - 2 },
      events: [],
      currentBallOwner: null
    };

    this.gameState$.next(initialState);

    // Start game loop
    this.lastTime = Date.now();
  this.lastPassTime = this.lastTime;
    this.startGameLoop();
    this.startGameTimer();

    // Add game start event
    this.generateGameEvent('substitution', 'Game Start', 'The match begins!');
  }

  // Adjust team2 color if too similar to team1 for better on-field contrast
  private ensureDistinctTeamColors(): void {
    if (!this.team1 || !this.team2) return;
    const hexToRgb = (hex: string) => {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      if (!m) return { r: 0, g: 0, b: 0 };
      return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    };
    const distance = (c1: string, c2: string) => {
      const a = hexToRgb(c1); const b = hexToRgb(c2);
      return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
    };
    if (distance(this.team1.color, this.team2.color) < 120) {
      // Invert team2 color for maximum separation
      const { r, g, b } = hexToRgb(this.team2.color);
      const inv = `#${(255 - r).toString(16).padStart(2, '0')}${(255 - g).toString(16).padStart(2, '0')}${(255 - b).toString(16).padStart(2, '0')}`;
      // If still close (rare), shift hue by simple channel rotation
      if (distance(this.team1.color, inv) < 120) {
        const rotated = `#${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${r.toString(16).padStart(2, '0')}`;
        this.team2.color = rotated.toUpperCase();
      } else {
        this.team2.color = inv.toUpperCase();
      }
    }
  }

  stopGame(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    const currentState = this.gameState$.value;
    this.gameState$.next({
      ...currentState,
      isRunning: false
    });

    this.generateGameEvent('substitution', 'Game Over', 'Match finished!');
  }

  private initializePlayerPositions(): void {
    if (!this.team1 || !this.team2) return;

    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;

    // Helper to distribute players by role using a simple 4-3-3 formation style
    const assignFormation = (team: Team, side: 'left' | 'right') => {
      const cols = {
        goalkeeper: side === 'left' ? 60 : fieldWidth - 60,
        defender: side === 'left' ? 160 : fieldWidth - 160,
        midfielder: side === 'left' ? 300 : fieldWidth - 300,
        forward: side === 'left' ? 460 : fieldWidth - 460
      };

      // Vertical lanes for spacing
      const lanesDef = [fieldHeight * 0.25, fieldHeight * 0.45, fieldHeight * 0.55, fieldHeight * 0.75];
      const lanesMid = [fieldHeight * 0.20, fieldHeight * 0.40, fieldHeight * 0.60];
      const lanesFwd = [fieldHeight * 0.35, fieldHeight * 0.50, fieldHeight * 0.65];

      let defIndex = 0, midIndex = 0, fwdIndex = 0;

      team.players.forEach(p => {
        switch (p.role) {
          case 'goalkeeper':
            p.position = { x: cols.goalkeeper, y: fieldHeight / 2 };
            break;
          case 'defender': {
            const lane = lanesDef[defIndex % lanesDef.length];
            p.position = { x: cols.defender, y: lane };
            defIndex++;
            break;
          }
          case 'midfielder': {
            const lane = lanesMid[midIndex % lanesMid.length];
            p.position = { x: cols.midfielder, y: lane };
            midIndex++;
            break;
          }
          case 'forward': {
            const lane = lanesFwd[fwdIndex % lanesFwd.length];
            p.position = { x: cols.forward, y: lane };
            fwdIndex++;
            break;
          }
        }
        // Store a base position anchor for smarter movement
        (p as any).basePosition = { ...p.position };
      });
    };

    assignFormation(this.team1, 'left');
    assignFormation(this.team2, 'right');
  }

  private startGameLoop(): void {
    const gameLoop = () => {
      const currentTime = Date.now();
      const deltaTime = currentTime - this.lastTime;
      this.lastTime = currentTime;

      this.updateGame(deltaTime);

      if (this.gameState$.value.isRunning) {
        this.animationFrameId = requestAnimationFrame(gameLoop);
      }
    };

    this.animationFrameId = requestAnimationFrame(gameLoop);
  }

  private startGameTimer(): void {
    this.gameTimer = window.setInterval(() => {
      const currentState = this.gameState$.value;
      const newTimeRemaining = Math.max(0, currentState.timeRemaining - 1);

      this.gameState$.next({
        ...currentState,
        timeRemaining: newTimeRemaining
      });

      if (newTimeRemaining <= 0) {
        this.stopGame();
      }
    }, 1000);
  }

  private updateGame(deltaTime: number): void {
    if (!this.gameState$.value.isRunning) return;

    // Update ball position
    this.updateBallPosition(deltaTime);

    // Update player positions
    this.updatePlayerPositions(deltaTime);

    // Possession & passing
    this.updatePossessionAndPassing(deltaTime);

    // Generate random events
    this.generateRandomEvents();
  }

  private updateBallPosition(deltaTime: number): void {
    const currentState = this.gameState$.value;
    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;

    let ball = { ...currentState.ball };

    // Apply physics scaled by deltaTime
    const dt = deltaTime / 16.67; // normalize to ~60fps base
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Bounce off walls
    if (ball.x <= 20 || ball.x >= fieldWidth - 20) {
      ball.vx *= -0.8;
      ball.x = Math.max(20, Math.min(fieldWidth - 20, ball.x));
    }
    
    if (ball.y <= 20 || ball.y >= fieldHeight - 20) {
      ball.vy *= -0.8;
      ball.y = Math.max(20, Math.min(fieldHeight - 20, ball.y));
    }

    // Add small randomness when free (no owner)
    if (!currentState.currentBallOwner) {
      ball.vx += (Math.random() - 0.5) * 0.15 * dt;
      ball.vy += (Math.random() - 0.5) * 0.15 * dt;
    }

    // Limit speed
    const maxSpeed = 3;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed > maxSpeed) {
      ball.vx = (ball.vx / speed) * maxSpeed;
      ball.vy = (ball.vy / speed) * maxSpeed;
    }

  // Apply friction
  const friction = currentState.currentBallOwner ? 0.995 : 0.99;
  ball.vx *= friction;
  ball.vy *= friction;

    this.gameState$.next({
      ...currentState,
      ball
    });

  // Physical goal detection using metric scaling
  const innerHeight = fieldHeight - 20; // inside boundary (top/bottom margins 10 each)
  const widthScale = innerHeight / environment.gameSettings.pitchWidthM; // px per meter (vertical)
  const goalMouthPx = environment.gameSettings.goalWidthM * widthScale;
  const goalZoneTop = (fieldHeight / 2) - goalMouthPx / 2;
  const goalZoneBottom = goalZoneTop + goalMouthPx;
    if (ball.x <= 22 && ball.y >= goalZoneTop && ball.y <= goalZoneBottom) {
      // Goal for team2
      this.generateGameEvent('goal', this.team2?.name || 'Team 2', 'Goal');
      this.updateScore('team2');
      this.resetBallPosition();
    } else if (ball.x >= fieldWidth - 22 && ball.y >= goalZoneTop && ball.y <= goalZoneBottom) {
      // Goal for team1
      this.generateGameEvent('goal', this.team1?.name || 'Team 1', 'Goal');
      this.updateScore('team1');
      this.resetBallPosition();
    } else {
      // Corner detection: ball hits side boundary outside goal vertical zone
      if (ball.x <= 20 && (ball.y < goalZoneTop || ball.y > goalZoneBottom)) {
        this.generateGameEvent('corner', this.team2?.name || 'Team 2', 'Corner');
      } else if (ball.x >= fieldWidth - 20 && (ball.y < goalZoneTop || ball.y > goalZoneBottom)) {
        this.generateGameEvent('corner', this.team1?.name || 'Team 1', 'Corner');
      }
    }
  }

  private updatePlayerPositions(deltaTime: number): void {
    if (!this.team1 || !this.team2) return;

    const currentState = this.gameState$.value;
    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;
    const ballPos = currentState.ball;
    const everyone = [...this.team1.players, ...this.team2.players];

    // Choose a limited number of chasers (closest 4 non-goalkeepers)
    const chasers = everyone
      .filter(p => p.role !== 'goalkeeper')
      .map(p => ({ p, d: Math.hypot(ballPos.x - p.position.x, ballPos.y - p.position.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4)
      .map(x => x.p);

  // Increase scaling to make movement faster (1 sim second = 1 match minute)
  const dt = (deltaTime / 16.67) * 1.8;
    everyone.forEach(player => {
      if (player.role === 'goalkeeper') {
        // Goalkeeper: track ball vertically, modest horizontal shift when ball enters attacking half
        const targetY = Math.max(40, Math.min(fieldHeight - 40, ballPos.y));
        const horizAdjust = Math.abs(ballPos.x - player.position.x) < fieldWidth * 0.55 ? (ballPos.x - player.position.x) * 0.004 : 0;
        player.position.x += horizAdjust * dt;
        player.position.y += (targetY - player.position.y) * 0.06 * dt;
        // Constrain keeper to a corridor near its goal (detect team by membership)
        const isLeftKeeper = !!this.team1 && this.team1.players.includes(player);
        player.position.x = isLeftKeeper
          ? Math.max(30, Math.min(120, player.position.x))
          : Math.max(fieldWidth - 120, Math.min(fieldWidth - 30, player.position.x));
        player.position.y = Math.max(40, Math.min(fieldHeight - 40, player.position.y));
        return;
      }
      const base = (player as any).basePosition || player.position;
      const isChasing = chasers.includes(player);
      const dx = ballPos.x - player.position.x;
      const dy = ballPos.y - player.position.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

    // Movement weighting (accelerated)
    const chaseFactor = (isChasing ? 1.6 : 0.25) * dt;
    const formationFactor = 0.06 * dt; // subtle pull to base

      // Random jitter to avoid perfect lines
  const jitterX = (Math.random() - 0.5) * 0.3 * dt;
  const jitterY = (Math.random() - 0.5) * 0.3 * dt;

      if (distance > 28) {
        const angle = Math.atan2(dy, dx);
        player.position.x += Math.cos(angle) * chaseFactor + (base.x - player.position.x) * formationFactor + jitterX;
        player.position.y += Math.sin(angle) * chaseFactor + (base.y - player.position.y) * formationFactor + jitterY;
      } else {
        // Close to ball: maintain some spacing by nudging toward base
        player.position.x += (base.x - player.position.x) * 0.07 * dt + jitterX;
        player.position.y += (base.y - player.position.y) * 0.07 * dt + jitterY;
      }

      // Keep players on field
      player.position.x = Math.max(30, Math.min(fieldWidth - 30, player.position.x));
      player.position.y = Math.max(30, Math.min(fieldHeight - 30, player.position.y));
    });
  }

  private updatePossessionAndPassing(deltaTime: number): void {
    if (!this.team1 || !this.team2) return;
    const currentState = this.gameState$.value;
    const ball = currentState.ball;
    const allPlayers = [...this.team1.players, ...this.team2.players];

    // Determine possession: closest player within radius
    const possessionRadius = 18;
    let owner: Player | null = null; // explicit type avoids 'never'
    let minDist = Infinity;
    allPlayers.forEach(p => {
      const d = Math.hypot(p.position.x - ball.x, p.position.y - ball.y);
      if (d < possessionRadius && d < minDist) {
        minDist = d;
        owner = p;
      }
    });

    let newOwnerId: string | null = null;
    if (owner !== null) {
      newOwnerId = (owner as Player).id;
    }

    // Passing logic: if owner exists and cooldown passed, pass forward to a teammate
    const now = Date.now();
    if (owner && now - this.lastPassTime > this.passCooldown) {
      const ownerPlayer = owner as Player; // stabilize narrowing for arrow callbacks
      const sameTeam: Player[] = this.team1.players.includes(ownerPlayer) ? this.team1.players : this.team2.players;
      const ownerSideLeft = ownerPlayer.position.x < environment.gameSettings.fieldWidth / 2;
      // Prefer players further forward in owner's attack direction
      const forwardCandidates: Player[] = sameTeam.filter(p => p.id !== ownerPlayer.id && (ownerSideLeft ? p.position.x > ownerPlayer.position.x : p.position.x < ownerPlayer.position.x));
      const candidates: Player[] = forwardCandidates.length > 0 ? forwardCandidates : sameTeam.filter(p => p.id !== ownerPlayer.id);
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        const dx = target.position.x - ball.x;
        const dy = target.position.y - ball.y;
        const dist = Math.hypot(dx, dy) || 1;
        const speed = 9; // faster pass speed to match accelerated simulation
        const vx = (dx / dist) * speed;
        const vy = (dy / dist) * speed;
        const updated = { ...currentState.ball, vx, vy };
        this.gameState$.next({ ...currentState, ball: updated, currentBallOwner: ownerPlayer.id });
        this.lastPassTime = now;
        this.generateGameEvent('substitution', (sameTeam === this.team1.players ? this.team1.name : this.team2!.name), `${ownerPlayer.name} PASS`);
        return;
      }
    }

    // Update state if ownership changed
    if (newOwnerId !== currentState.currentBallOwner) {
      this.gameState$.next({ ...currentState, currentBallOwner: newOwnerId });
    }
  }

  private generateRandomEvents(): void {
    // Remove random goal generation; keep rare fouls & offsides for flavor
    if (Math.random() < 0.0012) {
      const eventTypes = ['foul', 'offside', 'yellow_card'];
      const chosen = eventTypes[Math.floor(Math.random() * eventTypes.length)];
      const team = Math.random() < 0.5 ? this.team1 : this.team2;
      if (team) {
        const player = team.players[Math.floor(Math.random() * team.players.length)];
        this.generateGameEvent(chosen, team.name, player.name);
      }
    }
  }

  private resetBallPosition(): void {
    const currentState = this.gameState$.value;
    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;

    this.gameState$.next({
      ...currentState,
      ball: {
        x: fieldWidth / 2,
        y: fieldHeight / 2,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 0.5) * 4
      }
    });
  }

  private generateGameEvent(type: string, teamName: string, playerName: string): void {
    const currentState = this.gameState$.value;
    const totalTime = this.gameDuration;
    const elapsedTime = totalTime - currentState.timeRemaining;

     // Scale elapsedTime to real match minutes (45 min half simulation mapping)
     const scaleFactor = 45 / totalTime; // simulation duration maps to 45 real minutes
     const realMinuteFloat = elapsedTime * scaleFactor;
     const realMinute = Math.min(45, Math.floor(realMinuteFloat));
     const displayMins = Math.floor(realMinuteFloat);
     const displaySecs = Math.floor((realMinuteFloat - displayMins) * 60);
     const displayTime = `${displayMins.toString().padStart(2,'0')}:${displaySecs.toString().padStart(2,'0')}`;

    const event: GameEvent = {
      time: elapsedTime,
      type: type as any,
      team: teamName,
      player: playerName,
      description: this.getEventDescription(type, playerName, teamName),
      displayTime,
      realMinute
    };

    const newEvents = [...currentState.events, event];
    
    this.gameState$.next({
      ...currentState,
      events: newEvents
    });

    this.gameEvents$.next(event);
  }

  private updateScore(team: 'team1' | 'team2'): void {
    const currentState = this.gameState$.value;
    const newScore = { ...currentState.score };
    newScore[team]++;

    this.gameState$.next({
      ...currentState,
      score: newScore
    });
  }

  private getEventDescription(eventType: string, playerName: string, teamName: string): string {
    const events = {
      goal: `⚽ GOAAAAL! ${playerName} scores for ${teamName}!`,
      foul: `⚠️ ${playerName} commits a foul.`,
      corner: `🚩 Corner kick for ${teamName}!`,
      offside: `🚨 ${playerName} is caught offside!`,
      yellow_card: `🟨 Yellow card for ${playerName}!`,
      substitution: `🔄 ${playerName}`
    };

    return events[eventType as keyof typeof events] || `${playerName} is involved in the action!`;
  }
}