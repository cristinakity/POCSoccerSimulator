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
  // Possession protection mechanics
  private possessionLockOwner: string | null = null;
  private possessionLockUntil = 0; // timestamp in ms

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
    const speedCfg = environment.gameSettings.speed;
    const margin = 20; // existing boundary margin used in goal logic

    let ball = { ...currentState.ball };

    // Apply physics scaled by deltaTime
    const dt = deltaTime / 16.67; // normalize to ~60fps base
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Remove artificial bounces; handle only horizontal rebounds lightly (optional) and throw-ins for vertical exits
    // Horizontal (goal line) still handled later for goals/corners; if no goal/corner, just stop ball inside
    if (ball.x <= margin) {
      ball.x = margin;
    } else if (ball.x >= fieldWidth - margin) {
      ball.x = fieldWidth - margin;
    }

    // Touchlines (top/bottom): if ball exits, trigger throw-in event and reset ball for opposing team possession
    if (ball.y < margin || ball.y > fieldHeight - margin) {
      const exitingTop = ball.y < margin;
      // Determine last possessing team (currentBallOwner) to assign throw-in to opposite
      let lastOwnerTeamName = 'Unknown';
      if (currentState.currentBallOwner) {
        const all = [...(this.team1?.players||[]), ...(this.team2?.players||[])];
        const lastOwner = all.find(p => p.id === currentState.currentBallOwner);
        if (lastOwner) {
          lastOwnerTeamName = this.team1?.players.includes(lastOwner) ? this.team1!.name : this.team2!.name;
        }
      }
      const throwTeam = (lastOwnerTeamName === this.team1?.name) ? (this.team2?.name || 'Team 2') : (this.team1?.name || 'Team 1');
      this.generateGameEvent('substitution', throwTeam, exitingTop ? 'Throw-In (Top)' : 'Throw-In (Bottom)'); // reuse substitution icon placeholder
      // Place ball at touchline and give slight inward velocity for restart
      ball.y = exitingTop ? margin + 2 : fieldHeight - margin - 2;
      ball.vx = 0;
      ball.vy = 0;
    }

    // Remove random drift: ball only moves when kicked; if owned, anchor to owner's feet
    if (currentState.currentBallOwner) {
      const owner = [...(this.team1?.players||[]), ...(this.team2?.players||[])]
        .find(p => p.id === currentState.currentBallOwner);
      if (owner) {
        // Lightly position ball slightly ahead of player (direction based on side)
        const isLeftTeam = this.team1?.players.includes(owner) ?? false;
        const offsetX = isLeftTeam ? 10 : -10;
        ball.x = owner.position.x + offsetX;
        ball.y = owner.position.y;
        // Ball stays with player until a kick (pass/shot) sets velocity & clears owner
        ball.vx = 0;
        ball.vy = 0;
      }
    } else {
      // If free and velocity is very low, stop completely
      if (Math.hypot(ball.vx, ball.vy) < 0.05) {
        ball.vx = 0; ball.vy = 0;
      }
    }

    // Limit speed using config
    const speedMag = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speedMag > speedCfg.maxBallSpeed) {
      ball.vx = (ball.vx / speedMag) * speedCfg.maxBallSpeed;
      ball.vy = (ball.vy / speedMag) * speedCfg.maxBallSpeed;
    }

    // Apply friction (slightly less decay when possessed)
    const friction = currentState.currentBallOwner ? speedCfg.frictionPossessed : speedCfg.frictionFree;
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

    // Smarter chaser selection: if a team is in possession, prioritize opponents as chasers and limit teammates
    const currentOwnerId = this.gameState$.value.currentBallOwner;
    let ownerPlayer: Player | undefined;
    if (currentOwnerId) ownerPlayer = everyone.find(p => p.id === currentOwnerId);
    let chasers: Player[] = [];
    if (ownerPlayer) {
      const ownerTeam = this.team1.players.includes(ownerPlayer) ? this.team1.players : this.team2.players;
      const oppTeam = ownerTeam === this.team1.players ? this.team2.players : this.team1.players;
      const oppChasers = oppTeam
        .filter(p => p.role !== 'goalkeeper')
        .map(p => ({ p, d: Math.hypot(ballPos.x - p.position.x, ballPos.y - p.position.y) }))
        .sort((a,b) => a.d - b.d)
        .slice(0, 4)
        .map(x => x.p);
      const supportRunner = ownerTeam
        .filter(p => p.role !== 'goalkeeper' && p.id !== ownerPlayer!.id)
        .map(p => ({ p, d: Math.hypot(ownerPlayer!.position.x - p.position.x, ownerPlayer!.position.y - p.position.y) }))
        .sort((a,b) => a.d - b.d)
        .slice(0,1)
        .map(x => x.p);
      chasers = [...oppChasers, ...supportRunner];
    } else {
      chasers = everyone
        .filter(p => p.role !== 'goalkeeper')
        .map(p => ({ p, d: Math.hypot(ballPos.x - p.position.x, ballPos.y - p.position.y) }))
        .sort((a,b) => a.d - b.d)
        .slice(0,4)
        .map(x => x.p);
    }

  const speedCfg = environment.gameSettings.speed;
  // Normalize dt to ~60fps base
  const dtNorm = deltaTime / 16.67;
  const baseMove = speedCfg.playerBase * dtNorm;
    everyone.forEach(player => {
      // Stamina decay (light) each frame relative to normalized dt
      if (player.abilities) {
        const decay = 0.002 * dtNorm * (player.role === 'midfielder' ? 1.2 : 1) * (player.role === 'forward' ? 1.1 : 1);
        player.abilities.stamina = Math.max(0, player.abilities.stamina - decay);
      }
      if (player.role === 'goalkeeper') {
        // Goalkeeper: track ball vertically, modest horizontal shift when ball enters attacking half
        const targetY = Math.max(40, Math.min(fieldHeight - 40, ballPos.y));
        const horizAdjust = Math.abs(ballPos.x - player.position.x) < fieldWidth * 0.55 ? (ballPos.x - player.position.x) * 0.004 : 0;
        player.position.x += horizAdjust * baseMove;
        player.position.y += (targetY - player.position.y) * 0.06 * baseMove;
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
      // Movement weighting using config
  const staminaFactor = player.abilities ? (0.5 + 0.5 * (player.abilities.stamina / player.abilities.maxStamina)) : 1;
  const speedFactor = player.abilities ? player.abilities.speedFactor : 1;
  const chaseFactor = (isChasing ? (1 + speedCfg.chaseExtra) : 0.3) * baseMove * speedFactor * staminaFactor;
      const formationFactor = 0.06 * baseMove; // subtle pull to base

      // Random jitter to avoid perfect lines
  const jitterX = (Math.random() - 0.5) * 0.3 * baseMove;
  const jitterY = (Math.random() - 0.5) * 0.3 * baseMove;

      if (distance > 28) {
        const angle = Math.atan2(dy, dx);
        player.position.x += Math.cos(angle) * chaseFactor + (base.x - player.position.x) * formationFactor + jitterX;
        player.position.y += Math.sin(angle) * chaseFactor + (base.y - player.position.y) * formationFactor + jitterY;
      } else {
        // Close to ball: maintain some spacing by nudging toward base
        player.position.x += (base.x - player.position.x) * 0.07 * baseMove + jitterX;
        player.position.y += (base.y - player.position.y) * 0.07 * baseMove + jitterY;
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
    const speedCfg = environment.gameSettings.speed;
    const nowTs = Date.now();
    const possessionRadius = 18;
    let owner: Player | null = null;
    let newOwnerId: string | null = currentState.currentBallOwner;
    // If we already have an owner, respect lock; otherwise pick nearest
    if (currentState.currentBallOwner) {
      owner = allPlayers.find(p => p.id === currentState.currentBallOwner) || null;
      // Attempt opponent steals if lock expired
      if (owner && nowTs > this.possessionLockUntil) {
        const ownerTeamIsTeam1 = this.team1.players.includes(owner);
        const opponents = ownerTeamIsTeam1 ? this.team2.players : this.team1.players;
        // Find closest opponent
        let bestOpp: Player | null = null; let bestDist = Infinity;
        opponents.forEach(op => {
          const d = Math.hypot(op.position.x - ball.x, op.position.y - ball.y);
            if (d < possessionRadius && d < bestDist) { bestDist = d; bestOpp = op; }
        });
        if (bestOpp !== null) {
          const attackerStam = (bestOpp as Player).abilities ? (bestOpp as Player).abilities!.stamina : 50;
          const defenderStam = owner!.abilities ? owner!.abilities!.stamina : 50;
          const stealChance = 0.30 + Math.max(-0.15, Math.min(0.25, (attackerStam - defenderStam)/160));
          if (Math.random() < stealChance) {
            owner = bestOpp;
            newOwnerId = (bestOpp as Player).id;
            this.possessionLockOwner = newOwnerId;
            this.possessionLockUntil = nowTs + 1400;
          }
        }
      }
    } else {
      // No current owner: choose nearest
      let minDist = Infinity;
      allPlayers.forEach(p => {
        const d = Math.hypot(p.position.x - ball.x, p.position.y - ball.y);
        if (d < possessionRadius && d < minDist) { minDist = d; owner = p; }
      });
      if (owner) {
        newOwnerId = (owner as Player).id;
        this.possessionLockOwner = newOwnerId;
        this.possessionLockUntil = nowTs + 1500;
      }
    }

    // Apply forward dribble only if owner determined
    if (owner) {
      const ownerPlayer = owner;
      const isLeftTeam = this.team1.players.includes(ownerPlayer);
      const dir = isLeftTeam ? 1 : -1;
      // Dribble advance (scaled by playerBase)
      const advance = speedCfg.playerBase * 0.9;
      ownerPlayer.position.x += advance * dir;
      // mild lateral drift toward center line to avoid hugging touchline
      const centerY = environment.gameSettings.fieldHeight / 2;
      ownerPlayer.position.y += (centerY - ownerPlayer.position.y) * 0.002 * speedCfg.playerBase;
      // Keep within field
      ownerPlayer.position.x = Math.max(30, Math.min(environment.gameSettings.fieldWidth - 30, ownerPlayer.position.x));
      ownerPlayer.position.y = Math.max(30, Math.min(environment.gameSettings.fieldHeight - 30, ownerPlayer.position.y));

      // TEAM COOPERATION: supporting runs - nearby teammates on same side move forward into space instead of collapsing onto ball
      const sameTeam = this.team1.players.includes(ownerPlayer) ? this.team1.players : this.team2.players;
      sameTeam.forEach(tm => {
        if (tm.id === ownerPlayer.id) return;
        const dist = Math.hypot(tm.position.x - ownerPlayer.position.x, tm.position.y - ownerPlayer.position.y);
        if (dist < 180) {
          // Move into a forward supporting lane: slight horizontal advance + spread vertically
            const laneDir = dir;
            tm.position.x += laneDir * speedCfg.playerBase * 0.35;
            // vertical spacing: push away from owner to create passing lane
            const verticalSign = (tm.position.y < ownerPlayer.position.y) ? -1 : 1;
            tm.position.y += verticalSign * 0.25 * speedCfg.playerBase;
            tm.position.x = Math.max(30, Math.min(environment.gameSettings.fieldWidth - 30, tm.position.x));
            tm.position.y = Math.max(30, Math.min(environment.gameSettings.fieldHeight - 30, tm.position.y));
        }
      });
    }

    // Passing / shooting logic: if owner exists and cooldown passed, first consider shot, else pass forward
    const now = Date.now();
    if (owner && now - this.lastPassTime > this.passCooldown) {
      const ownerPlayer = owner as Player; // stabilize narrowing for arrow callbacks
      const sameTeam: Player[] = this.team1.players.includes(ownerPlayer) ? this.team1.players : this.team2.players;
      const ownerSideLeft = ownerPlayer.position.x < environment.gameSettings.fieldWidth / 2;
      const attackingGoalX = ownerSideLeft ? environment.gameSettings.fieldWidth - 20 : 20;
      // Shooting logic: if owner near opponent penalty area (within 140px horizontally of goal line)
      const distanceToGoalLine = Math.abs(attackingGoalX - ownerPlayer.position.x);
      const goalMouthHalf = (environment.gameSettings.goalWidthM * (environment.gameSettings.fieldHeight - 20) / environment.gameSettings.pitchWidthM) / 2;
      const withinVerticalGoalSpan = Math.abs(ownerPlayer.position.y - environment.gameSettings.fieldHeight/2) < goalMouthHalf + 120; // generous corridor
      // Increase shooting frequency by enlarging trigger window and adding probability weighting
      const staminaFactor = ownerPlayer.abilities ? (0.5 + 0.5 * (ownerPlayer.abilities.stamina / ownerPlayer.abilities.maxStamina)) : 1;
      const powerFactor = ownerPlayer.abilities ? (0.6 + ownerPlayer.abilities.shotPower / 100 * 0.8) : 1; // 0.6 - 1.4
      const accuracyFactor = ownerPlayer.abilities ? (0.5 + ownerPlayer.abilities.accuracy / 100 * 0.5) : 1; // 0.5 - 1.0 spread reduction
      const shootProbability = distanceToGoalLine < 90 ? 0.75 + (powerFactor - 1) * 0.2 : distanceToGoalLine < 140 ? 0.45 + (powerFactor - 1) * 0.15 : 0;
      if (shootProbability > 0 && Math.random() < shootProbability && withinVerticalGoalSpan) {
        // Attempt shot
        const aimSpread = goalMouthHalf * (1.2 - 0.7 * accuracyFactor); // better accuracy narrows spread
        const targetY = (environment.gameSettings.fieldHeight / 2) + (Math.random() - 0.5) * aimSpread;
        const dxShot = attackingGoalX - ball.x;
        const dyShot = targetY - ball.y;
        const dShot = Math.hypot(dxShot, dyShot) || 1;
        const shotSpeed = speedCfg.shotSpeed * powerFactor * staminaFactor;
        const vxShot = (dxShot / dShot) * shotSpeed;
        const vyShot = (dyShot / dShot) * shotSpeed;
        const updatedBall = { ...ball, vx: vxShot, vy: vyShot };
        // Release ownership so ball travels
        this.gameState$.next({ ...currentState, ball: updatedBall, currentBallOwner: null });
        this.lastPassTime = now; // reuse cooldown
        this.generateGameEvent('shot', (sameTeam === this.team1.players ? this.team1.name : this.team2!.name), ownerPlayer.name);
        return;
      }
      // Prefer players further forward in owner's attack direction
      let forwardCandidates: Player[] = sameTeam.filter(p => p.id !== ownerPlayer.id && (ownerSideLeft ? p.position.x > ownerPlayer.position.x : p.position.x < ownerPlayer.position.x));
      // Weight candidates by how advanced they are (favor through play)
      if (forwardCandidates.length > 0) {
        forwardCandidates = forwardCandidates.sort((a,b) => ownerSideLeft ? b.position.x - a.position.x : a.position.x - b.position.x).slice(0,4);
      }
      const fallback = sameTeam.filter(p => p.id !== ownerPlayer.id);
      const candidates: Player[] = forwardCandidates.length > 0 ? forwardCandidates : fallback;
      if (candidates.length > 0) {
        // bias toward first (most advanced) 60% of the time
        let target: Player;
        if (Math.random() < 0.6) {
          target = candidates[0];
        } else {
          target = candidates[Math.floor(Math.random() * candidates.length)];
        }
        const dx = target.position.x - ball.x;
        const dy = target.position.y - ball.y;
        const dist = Math.hypot(dx, dy) || 1;
        const passPowerFactor = ownerPlayer.abilities ? (0.5 + ownerPlayer.abilities.passPower / 100 * 0.9) : 1; // 0.5 - 1.4
        const passAccuracyFactor = ownerPlayer.abilities ? (0.5 + ownerPlayer.abilities.accuracy / 100 * 0.5) : 1;
        const passSpeed = environment.gameSettings.speed.passSpeed * passPowerFactor;
        // Slight target leading using target speedFactor
        const lead = target.abilities ? (target.abilities.speedFactor * 4) : 2;
        const targetX = target.position.x + (ownerSideLeft ? lead : -lead);
        const targetY = target.position.y + (Math.random() - 0.5) * (18 / passAccuracyFactor); // less vertical randomness with higher accuracy
        const ndx = targetX - ball.x;
        const ndy = targetY - ball.y;
        const ndist = Math.hypot(ndx, ndy) || 1;
        const vx = (ndx / ndist) * passSpeed;
        const vy = (ndy / ndist) * passSpeed;
        const updated = { ...currentState.ball, vx, vy };
        // Release ownership on pass so receiving player must acquire when close
        this.gameState$.next({ ...currentState, ball: updated, currentBallOwner: null });
        this.lastPassTime = now;
        this.generateGameEvent('pass', (sameTeam === this.team1.players ? this.team1.name : this.team2!.name), `${ownerPlayer.name}→${target.name}`);
        return;
      }
    }

    // Update state if ownership changed
    if (newOwnerId !== currentState.currentBallOwner) {
      this.gameState$.next({ ...currentState, currentBallOwner: newOwnerId });
    }
  }

  private lastFoulTime = 0;
  private foulCooldownMs = 4000;
  private generateRandomEvents(): void {
    if (!this.team1 || !this.team2) return;
    const now = Date.now();
    const everyone = [...this.team1.players, ...this.team2.players];

    // Collision-based foul chance with cooldown and velocity component to reduce spam
    if (now - this.lastFoulTime > this.foulCooldownMs) {
      const foulCandidates: { offender: Player; team: Team; impact: number }[] = [];
      for (let i = 0; i < everyone.length; i++) {
        for (let j = i + 1; j < everyone.length; j++) {
          const a = everyone[i];
          const b = everyone[j];
          const same = (this.team1.players.includes(a) && this.team1.players.includes(b)) || (this.team2.players.includes(a) && this.team2.players.includes(b));
          if (same) continue;
          const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
          if (d < 18) { // tighter collision distance
            // approximate impact by recent ball speed relevance (if close to ball)
            foulCandidates.push({ offender: a, team: this.team1.players.includes(a) ? this.team1 : this.team2, impact: 1 / (d + 1) });
          }
        }
      }
      if (foulCandidates.length > 0 && Math.random() < 0.18) {
        const chosen = foulCandidates[Math.floor(Math.random() * foulCandidates.length)];
        const eventTypeRoll = Math.random();
        let ev: string = 'foul';
        if (eventTypeRoll > 0.93) ev = 'yellow_card';
        this.generateGameEvent(ev, chosen.team.name, chosen.offender.name);
        this.lastFoulTime = now;
        return;
      }
    }

    // Reduced frequency offside logic
    if (Math.random() < 0.0012) {
      const leftAttackers = this.team1.players.filter(p => p.role !== 'goalkeeper');
      const rightAttackers = this.team2.players.filter(p => p.role !== 'goalkeeper');
      if (leftAttackers.length && rightAttackers.length) {
        const leftMostDefenderRightTeam = Math.min(...rightAttackers.map(p => p.position.x));
        const rightMostDefenderLeftTeam = Math.max(...leftAttackers.map(p => p.position.x));
        const potentialOffsideLeft = leftAttackers.filter(p => p.position.x > leftMostDefenderRightTeam + 35);
        const potentialOffsideRight = rightAttackers.filter(p => p.position.x < rightMostDefenderLeftTeam - 35);
        const pool = [...potentialOffsideLeft, ...potentialOffsideRight];
        if (pool.length > 0) {
          const offender = pool[Math.floor(Math.random() * pool.length)];
          const offenderTeam = this.team1.players.includes(offender) ? this.team1 : this.team2;
          this.generateGameEvent('offside', offenderTeam.name, offender.name);
        }
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
      substitution: `🔄 ${playerName}`,
      pass: `➡️ ${playerName} passes the ball.`,
      shot: `🎯 ${playerName} takes a shot!`
    };

    return events[eventType as keyof typeof events] || `${playerName} is involved in the action!`;
  }
}