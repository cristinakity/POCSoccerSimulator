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
  currentBallOwner: string | null;
  phase?: 'pregame' | 'kickoff' | 'inplay' | 'finished';
  kickoffTeamName?: string | null;
}

@Injectable({ providedIn: 'root' })
export class GameEngineService {
  private gameState$ = new BehaviorSubject<GameState>({
    isRunning: false,
    timeRemaining: 0,
    score: { team1: 0, team2: 0 },
    ball: { x: 450, y: 300, vx: 0, vy: 0 },
    events: [],
    currentBallOwner: null,
    phase: 'pregame',
    kickoffTeamName: null
  });
  private gameEvents$ = new Subject<GameEvent>();
  private animationFrameId: number | null = null;
  private gameTimer: any | null = null;
  private lastTime = 0;
  private lastPassTime = 0;
  private passCooldown = 2500;
  private basePassCooldown = 2500;
  private possessionLockOwner: string | null = null;
  private possessionLockUntil = 0;
  private team1: Team | null = null;
  private team2: Team | null = null;
  private gameDuration = environment.gameSettings.defaultGameDuration;
  private consecutiveNonAdvancingPasses = 0;
  private maxPossessionMs = 5000;
  private possessionStartTime = 0;
  private recentOwners: string[] = [];
  private stagnationStartTs = 0;
  private stagnationRefX = 0;

  getGameState(): Observable<GameState> { return this.gameState$.asObservable(); }
  getGameEvents(): Observable<GameEvent> { return this.gameEvents$.asObservable(); }

  startGame(team1: Team, team2: Team, duration: number = this.gameDuration): void {
    this.team1 = team1; this.team2 = team2; this.gameDuration = duration;
    this.ensureDistinctTeamColors();
    this.initializePlayerPositions();
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    const initialState: GameState = {
      isRunning: false,
      timeRemaining: duration,
      score: { team1: 0, team2: 0 },
      ball: { x: fieldW/2, y: fieldH/2, vx: 0, vy: 0 },
      events: [],
      currentBallOwner: null,
      phase: 'pregame',
      kickoffTeamName: null
    };
    this.gameState$.next(initialState);
    // Coin toss determines kickoff
    const coinWinner = Math.random() < 0.5 ? this.team1! : this.team2!;
  // Record kickoff winner in state, then emit coin toss event with explicit kickoff info
  this.gameState$.next({ ...this.gameState$.value, kickoffTeamName: coinWinner.name });
  this.generateGameEvent('coin_toss', coinWinner.name, 'Referee');
    // Assign kickoff player (center midfielder preferred)
    const midfielders = coinWinner.players.filter(p => p.role === 'midfielder');
    const kickoffPlayer = midfielders.sort((a,b) => Math.hypot(a.position.x-fieldW/2,a.position.y-fieldH/2) - Math.hypot(b.position.x-fieldW/2,b.position.y-fieldH/2))[0] || coinWinner.players[0];
    if (kickoffPlayer) {
      kickoffPlayer.position.x = fieldW/2 - (this.team1 === coinWinner ? 8 : -8);
      kickoffPlayer.position.y = fieldH/2;
      this.gameState$.next({
        ...this.gameState$.value,
        currentBallOwner: kickoffPlayer.id,
        ball: { ...this.gameState$.value.ball, x: fieldW/2, y: fieldH/2, vx: 0, vy: 0 },
        phase: 'kickoff'
      });
      this.possessionStartTime = Date.now();
      this.possessionLockOwner = kickoffPlayer.id;
      this.possessionLockUntil = Date.now() + 600;
    }
    this.recentOwners = []; this.stagnationStartTs = Date.now(); this.stagnationRefX = fieldW/2;
    this.lastTime = Date.now(); this.lastPassTime = this.lastTime;
    // Slightly lower early pass cooldown to encourage opening interaction
    this.passCooldown = 1600; this.basePassCooldown = 1600;
    this.startGameLoop();
    // Perform kickoff touch/pass then start timer & phase inplay
    setTimeout(() => {
      const gs = this.gameState$.value;
      if (gs.phase !== 'kickoff') return;
      const owner = [...(this.team1?.players||[]), ...(this.team2?.players||[])].find(p => p.id === gs.currentBallOwner);
      if (owner) {
        const dir = (this.team1?.players.includes(owner) ? 1 : -1);
        const teamPlayers = (this.team1?.players.includes(owner) ? this.team1!.players : this.team2!.players).filter(p => p.id !== owner.id);
        const target = teamPlayers.find(p => p.role === 'midfielder') || teamPlayers[0];
        if (target) {
          const dx = (target.position.x - gs.ball.x) || dir * 22;
          const dy = (target.position.y - gs.ball.y) || (Math.random()-0.5)*14;
          const dist = Math.hypot(dx, dy) || 1;
          const speedCfg = environment.gameSettings.speed;
          const vx = (dx/dist) * speedCfg.passSpeed * 0.65;
          const vy = (dy/dist) * speedCfg.passSpeed * 0.65;
          this.gameState$.next({ ...gs, ball: { ...gs.ball, vx, vy }, currentBallOwner: null });
          this.generateGameEvent('kickoff', coinWinner.name, owner.name);
          this.lastPassTime = Date.now();
        }
      }
      this.gameState$.next({ ...this.gameState$.value, isRunning: true, phase: 'inplay' });
      this.startGameTimer();
    }, 1200);
  }

  stopGame(): void {
    if (!this.gameState$.value.isRunning) return;
    this.gameState$.next({ ...this.gameState$.value, isRunning: false });
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    if (this.gameTimer) clearInterval(this.gameTimer);
    this.animationFrameId = null; this.gameTimer = null;
  }

  private ensureDistinctTeamColors(): void {
    if (!this.team1 || !this.team2) return;
    // Simple contrast tweak: if same color string, adjust team2
    if (this.team1.color === this.team2.color) {
      this.team2.color = this.team2.color === '#ff0000' ? '#0000ff' : '#ff0000';
    }
  }

  private initializePlayerPositions(): void {
    if (!this.team1 || !this.team2) return;
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    // Formation templates for our fixed role counts (1 GK, 4 DEF, 3 MID, 3 FWD)
    // Each formation defines relative X (depth) for lines and spread factors for Y.
    const formations = [
      { name: '4-3-3_standard', defX: 0.18, midX: 0.42, fwdX: 0.68, defSpread: 0.42, midSpread: 0.50, fwdSpread: 0.55 },
      { name: '4-3-3_wide', defX: 0.20, midX: 0.45, fwdX: 0.70, defSpread: 0.48, midSpread: 0.58, fwdSpread: 0.70 },
      { name: '4-4-2_shape', defX: 0.22, midX: 0.48, fwdX: 0.72, defSpread: 0.46, midSpread: 0.60, fwdSpread: 0.40 },
      { name: '3-4-3_press', defX: 0.26, midX: 0.50, fwdX: 0.74, defSpread: 0.55, midSpread: 0.62, fwdSpread: 0.58 },
      { name: '5-3-2_block', defX: 0.16, midX: 0.40, fwdX: 0.66, defSpread: 0.50, midSpread: 0.46, fwdSpread: 0.30 }
    ];
    const pickFormation = () => formations[Math.floor(Math.random()*formations.length)];
    const placeTeam = (team: Team, isLeft: boolean) => {
      const f = pickFormation();
      const dir = isLeft ? 1 : -1;
      // Separate players by role
      const gk = team.players.find(p => p.role === 'goalkeeper');
      const defenders = team.players.filter(p => p.role === 'defender');
      const mids = team.players.filter(p => p.role === 'midfielder');
      const fwds = team.players.filter(p => p.role === 'forward');
      const centerY = fieldH/2;
      // Helper to assign a line (players array, depth factor, spread factor)
      const assignLine = (pls: Player[], depth: number, spread: number, verticalJitter: number = 18) => {
        if (!pls.length) return;
        // Sort for consistent ordering, then distribute across spread vertically
        const n = pls.length;
        pls.forEach((p, i) => {
          const rel = n === 1 ? 0 : (i/(n-1) - 0.5); // -0.5 .. 0.5
          const y = centerY + rel * spread * fieldH + (Math.random()-0.5)*verticalJitter;
          const baseX = depth * fieldW;
          // Mirror for right side team
          const x = isLeft ? baseX : fieldW - baseX;
          p.position.x = x + (Math.random()-0.5)*14; // small horizontal jitter
          p.position.y = Math.max(40, Math.min(fieldH-40, y));
          (p as any).basePosition = { x: p.position.x, y: p.position.y };
        });
      };
      // Goalkeeper near own goal area
      if (gk) {
        const gkDepth = 0.06 * fieldW;
        gk.position.x = isLeft ? gkDepth : fieldW - gkDepth;
        gk.position.y = centerY + (Math.random()-0.5)*30;
        (gk as any).basePosition = { x: gk.position.x, y: gk.position.y };
      }
      // Adjust counts for formations that imply different line numbers (e.g., 5 defenders)
      // We keep roster static; for 5-3-2 we push one forward deeper as wing-back style.
      if (f.name === '5-3-2_block' && defenders.length === 4 && fwds.length === 3) {
        // Temporarily treat one forward as an auxiliary defender for shape
        const aux = fwds.pop();
        if (aux) defenders.push(aux);
      }
      if (f.name === '3-4-3_press' && defenders.length === 4 && mids.length === 3) {
        // Pull one defender into midfield line to mimic 3-4 shape
        const pulled = defenders.pop();
        if (pulled) mids.push(pulled);
      }
      assignLine(defenders, f.defX, f.defSpread);
      assignLine(mids, f.midX, f.midSpread);
      assignLine(fwds, f.fwdX, f.fwdSpread);
    };
    placeTeam(this.team1, true);
    placeTeam(this.team2, false);
  }

  private startGameLoop(): void {
    const loop = () => {
      const gs = this.gameState$.value;
      const now = Date.now();
      const delta = now - this.lastTime;
      this.lastTime = now;
      // Always keep loop alive; only advance simulation when in active play
      if (gs.isRunning && gs.phase === 'inplay') {
        this.updateBallPosition(delta);
        this.updatePlayerPositions(delta);
        this.updatePossessionAndPassing(delta);
        this.generateRandomEvents();
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
        this.stopGame();
      } else {
        this.gameState$.next({ ...gs, timeRemaining: gs.timeRemaining - 1 });
      }
    }, 1000);
  }

  private updateBallPosition(delta: number): void {
    const state = this.gameState$.value;
    let { x, y, vx, vy } = state.ball;
    const speedCfg = environment.gameSettings.speed;
    if (state.currentBallOwner) {
      const owner = [...(this.team1?.players||[]), ...(this.team2?.players||[])].find(p => p.id === state.currentBallOwner);
      if (owner) { x = owner.position.x; y = owner.position.y; vx = 0; vy = 0; }
    } else {
      x += vx; y += vy;
      const friction = speedCfg.frictionFree;
      vx *= friction; vy *= friction;
      if (Math.abs(vx) < 0.05) vx = 0; if (Math.abs(vy) < 0.05) vy = 0;
      // Out-of-bounds detection -> trigger throw-in restart ("saque de banda")
      const fieldW = environment.gameSettings.fieldWidth;
      const fieldH = environment.gameSettings.fieldHeight;
      const touchMargin = 5; // small margin beyond which we consider ball out
      if (y < touchMargin || y > fieldH - touchMargin) {
        this.handleThrowIn(x, y);
        return; // restart performed
      }
      // (Future: goal line exits x < 0 or x > fieldW could become corner/goal_kick events)
    }
    this.gameState$.next({ ...state, ball: { x, y, vx, vy } });
  }

  private updatePlayerPositions(delta: number): void {
    if (!this.team1 || !this.team2) return;
    const state = this.gameState$.value;
    const ballPos = state.ball;
    const team1Players = this.team1!.players;
    const team2Players = this.team2!.players;
    const everyone = [...team1Players, ...team2Players];
    const speedCfg = environment.gameSettings.speed;
    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;
    const dtNorm = delta / 16.67;
    const baseMove = speedCfg.playerBase * dtNorm;
    // Identify ball owner (if any) for contextual movement (pressing / support shapes)
    const ownerId = state.currentBallOwner;
    const ballOwner: Player | undefined = ownerId ? everyone.find(p => p.id === ownerId) : undefined;
    let ownerTeam: Player[] = [];
    let oppTeam: Player[] = [];
    if (ballOwner) {
      const ownerOnTeam1 = team1Players.includes(ballOwner);
      ownerTeam = ownerOnTeam1 ? team1Players : team2Players;
      oppTeam = ownerOnTeam1 ? team2Players : team1Players;
    }
    // Defensive role assignment: primary presser + secondary lane blocker
    let primaryPresser: Player | undefined;
    let secondaryBlocker: Player | undefined;
    if (ballOwner) {
      const sortedOpp = [...oppTeam].sort((a,b) => Math.hypot(a.position.x-ballOwner!.position.x,a.position.y-ballOwner!.position.y) - Math.hypot(b.position.x-ballOwner!.position.x,b.position.y-ballOwner!.position.y));
      primaryPresser = sortedOpp[0];
      secondaryBlocker = sortedOpp[1];
    }
    // Simple chaser selection: closest 4 to ball
    const sorted = [...everyone].sort((a,b) => Math.hypot(a.position.x-ballPos.x,a.position.y-ballPos.y) - Math.hypot(b.position.x-ballPos.x,b.position.y-ballPos.y));
    const chasers = sorted.slice(0,4);
    everyone.forEach(player => {
      if (player.abilities) {
        const decay = 0.002 * dtNorm * (player.role === 'midfielder' ? 1.2 : 1) * (player.role === 'forward' ? 1.1 : 1);
        player.abilities.stamina = Math.max(0, player.abilities.stamina - decay);
      }
      if (player.role === 'goalkeeper') {
        const isLeftKeeper = team1Players.includes(player);
        const defendingHalf = isLeftKeeper ? (ballPos.x < fieldWidth * 0.6) : (ballPos.x > fieldWidth * 0.4);
        const dangerZone = isLeftKeeper ? (ballPos.x < 220) : (ballPos.x > fieldWidth - 220);
        const anticipateY = ballPos.y + ballPos.vy * 4;
        const clampedAnticipateY = Math.max(60, Math.min(fieldHeight - 60, anticipateY));
        const verticalSpeed = (dangerZone ? 0.10 : defendingHalf ? 0.06 : 0.035) * baseMove;
        player.position.y += (clampedAnticipateY - player.position.y) * verticalSpeed;
        const baseLineX = isLeftKeeper ? 50 : fieldWidth - 50;
        const maxAdvance = 70;
        const ballDistToGoal = Math.abs(ballPos.x - baseLineX);
        const advanceRatio = 1 - Math.min(1, ballDistToGoal / 500);
        const targetDepth = baseLineX + (isLeftKeeper ? 1 : -1) * maxAdvance * advanceRatio;
        const depthLerp = dangerZone ? 0.09 : 0.04;
        player.position.x += (targetDepth - player.position.x) * depthLerp * baseMove;
        if (!('_jitPhase' in (player as any))) (player as any)._jitPhase = Math.random() * Math.PI * 2;
        (player as any)._jitPhase += 0.05 + (isLeftKeeper ? 0.015 : 0.03);
        const amp = isLeftKeeper ? 2.2 : 3.5;
        player.position.y += Math.sin((player as any)._jitPhase) * amp * dtNorm;
        if (isLeftKeeper) {
          player.position.x = Math.max(30, Math.min(140, player.position.x));
        } else {
          player.position.x = Math.max(fieldWidth - 140, Math.min(fieldWidth - 30, player.position.x));
        }
        player.position.y = Math.max(40, Math.min(fieldHeight - 40, player.position.y));
        return;
      }
      const base = (player as any).basePosition || player.position;
      const isChasing = chasers.includes(player);
      const dx = ballPos.x - player.position.x;
      const dy = ballPos.y - player.position.y;
      const distance = Math.hypot(dx, dy);
      const staminaFactor = player.abilities ? (0.5 + 0.5 * (player.abilities.stamina / player.abilities.maxStamina)) : 1;
      const speedFactor = player.abilities ? player.abilities.speedFactor : 1;
      // Enhanced defensive logic: if assigned presser / lane blocker give bespoke movement multipliers
      const isPrimaryPresser = primaryPresser === player;
      const isSecondaryBlocker = secondaryBlocker === player;
      const chaseMultiplier = isPrimaryPresser ? (1.35 + speedCfg.chaseExtra) : isSecondaryBlocker ? 0.95 : (isChasing ? (1 + speedCfg.chaseExtra) : 0.3);
      const chaseFactor = chaseMultiplier * baseMove * speedFactor * staminaFactor;
      const formationFactor = 0.06 * baseMove;
      let jitterX = (Math.random() - 0.5) * 0.08 * baseMove;
      let jitterY = (Math.random() - 0.5) * 0.08 * baseMove;
      // If secondary blocker: move toward an anticipated passing lane (ahead of owner on a slight offset)
      if (isSecondaryBlocker && ballOwner) {
        const dir = ownerTeam.includes(ballOwner) ? (team1Players.includes(ballOwner) ? 1 : -1) : 1; // fallback
        const laneAheadX = ballOwner.position.x + dir * 70;
        const laneAheadY = ballOwner.position.y + (ballOwner.position.y < fieldHeight/2 ? 28 : -28);
        const ldx = laneAheadX - player.position.x;
        const ldy = laneAheadY - player.position.y;
        player.position.x += ldx * 0.04 * dtNorm * speedFactor;
        player.position.y += ldy * 0.04 * dtNorm * speedFactor;
        // Light clamp
        player.position.x = Math.max(30, Math.min(fieldWidth - 30, player.position.x));
        player.position.y = Math.max(30, Math.min(fieldHeight - 30, player.position.y));
        return; // skip normal chase/formation for blocker this frame
      }
      if (!isChasing) {
        if (!(player as any)._laneTarget) (player as any)._laneTarget = { x: base.x, y: base.y };
        const tgt = (player as any)._laneTarget;
        if (!(player as any)._laneRecalc || Date.now() > (player as any)._laneRecalc) {
          const forwardBias = player.role === 'forward' ? 60 : player.role === 'midfielder' ? 40 : 20;
          const dir = team1Players.includes(player) ? 1 : -1;
          tgt.x = base.x + dir * (Math.random() * forwardBias);
          tgt.y = base.y + (Math.random() - 0.5) * 50;
          (player as any)._laneRecalc = Date.now() + 1200 + Math.random() * 1800;
        }
        jitterX += (tgt.x - player.position.x) * 0.015 * baseMove;
        jitterY += (tgt.y - player.position.y) * 0.015 * baseMove;
      }
      if (distance > 28) {
        const ang = Math.atan2(dy, dx);
        player.position.x += Math.cos(ang) * chaseFactor + (base.x - player.position.x) * formationFactor + jitterX;
        player.position.y += Math.sin(ang) * chaseFactor + (base.y - player.position.y) * formationFactor + jitterY;
      } else {
        player.position.x += (base.x - player.position.x) * 0.05 * baseMove + jitterX;
        player.position.y += (base.y - player.position.y) * 0.05 * baseMove + jitterY;
      }
      player.position.x = Math.max(30, Math.min(fieldWidth - 30, player.position.x));
      player.position.y = Math.max(30, Math.min(fieldHeight - 30, player.position.y));
    });
  }
  private updatePossessionAndPassing(deltaTime: number): void {
    if (!this.team1 || !this.team2) return;
    if (this.gameState$.value.phase && (this.gameState$.value.phase === 'pregame' || this.gameState$.value.phase === 'kickoff')) return;
    const state = this.gameState$.value;
    const ball = state.ball;
    const all = [...this.team1.players, ...this.team2.players];
    const speedCfg = environment.gameSettings.speed;
    const baseMove = speedCfg.playerBase * (deltaTime / 16.67);
    const now = Date.now();
    const possessionRadius = 18;
    let owner: Player | null = null;
    let newOwner: string | null = state.currentBallOwner;
    if (state.currentBallOwner) {
      owner = all.find(p => p.id === state.currentBallOwner) || null;
      if (owner && now > this.possessionLockUntil) {
        const ownerIsTeam1 = this.team1!.players.includes(owner);
        const opponents: Player[] = ownerIsTeam1 ? this.team2!.players : this.team1!.players;
        let closestOpp: Player | undefined; let bestD = Infinity;
        for (const o of opponents) {
          const d = Math.hypot(o.position.x - ball.x, o.position.y - ball.y);
          if (d < possessionRadius && d < bestD) { bestD = d; closestOpp = o; }
        }
        if (closestOpp) {
          const atkStam = closestOpp.abilities ? closestOpp.abilities.stamina : 50;
          const defStam = owner.abilities ? owner.abilities.stamina : 50;
          const baseSteal = 0.28 + Math.max(-0.15, Math.min(0.25, (atkStam - defStam) / 160));
          const possessionElapsed = now - this.possessionStartTime; // ms ball held by current owner
          // Fairness boost: longer uninterrupted possession increases steal odds gradually
          const durationBoost = Math.min(0.22, possessionElapsed / 6000 * 0.22); // up to +22% after 6s
          const fatigueBoost = owner.abilities ? (1 - (owner.abilities.stamina / owner.abilities.maxStamina)) * 0.18 : 0; // low stamina -> easier steal
          const stealChance = baseSteal + durationBoost + fatigueBoost;
          if (Math.random() < stealChance) {
            // Tackle event metadata
            (this as any)._eventExtra = {
              startX: ball.x,
              startY: ball.y,
              endX: ball.x,
              endY: ball.y,
              role: closestOpp.role,
              subtype: 'tackle',
              result: 'won'
            };
            const oppTeamName = this.team1.players.includes(closestOpp) ? this.team1.name : this.team2!.name;
            this.generateGameEvent('tackle', oppTeamName, closestOpp.name);
            owner = closestOpp; newOwner = closestOpp.id;
            this.possessionLockOwner = newOwner; this.possessionLockUntil = now + 900; this.possessionStartTime = now;
          }
        }
      }
    } else {
      let minD = Infinity;
      all.forEach(p => { const d = Math.hypot(p.position.x - ball.x, p.position.y - ball.y); if (d < possessionRadius && d < minD) { minD = d; owner = p; } });
  if (owner) { const o = owner as Player; newOwner = o.id; this.possessionLockOwner = newOwner; this.possessionLockUntil = now + 900; this.possessionStartTime = now; }
    }
    if (owner) {
  const leftSide = this.team1!.players.includes(owner);
      const dir = leftSide ? 1 : -1;
      const staminaBoost = owner.abilities ? (0.6 + 0.4 * (owner.abilities.stamina / owner.abilities.maxStamina)) : 1;
      const advance = speedCfg.playerBase * 1.3 * staminaBoost;
      owner.position.x += advance * dir;
      const centerY = environment.gameSettings.fieldHeight / 2;
      // Evasive lateral drift: choose side with more space (farther average opponent distance)
      const opponents: Player[] = leftSide ? this.team2!.players : this.team1!.players;
      const forwardVec = { x: dir, y: 0 };
      let aggLeft = 0, aggRight = 0, countL = 0, countR = 0;
      for (const o of opponents) {
        const ox = o.position.x - owner.position.x;
        const oy = o.position.y - owner.position.y;
        const dist = Math.hypot(ox, oy) || 1;
        // Side via cross product sign with forward vector (forward x opponentVec in 2D reduces to sign of oy)
        if (oy < 0) { aggLeft += dist; countL++; } else { aggRight += dist; countR++; }
      }
      const avgLeft = countL ? aggLeft / countL : 999;
      const avgRight = countR ? aggRight / countR : 999;
      const lateralDir = avgLeft > avgRight ? -1 : 1; // move toward side with greater avg distance (more space)
      const lateralStride = baseMove * 0.55 * staminaBoost;
      owner.position.y += lateralStride * lateralDir;
      // Small centering pull so player doesn't drift endlessly
      owner.position.y += (centerY - owner.position.y) * 0.0015 * speedCfg.playerBase;
      owner.position.x = Math.max(30, Math.min(environment.gameSettings.fieldWidth - 30, owner.position.x));
      owner.position.y = Math.max(30, Math.min(environment.gameSettings.fieldHeight - 30, owner.position.y));
      if (!this.recentOwners.length || this.recentOwners[this.recentOwners.length - 1] !== owner.id) { this.recentOwners.push(owner.id); if (this.recentOwners.length > 10) this.recentOwners.shift(); }
      if (Math.abs(ball.x - this.stagnationRefX) > 55) { this.stagnationRefX = ball.x; this.stagnationStartTs = now; }
  const sameTeam = this.team1!.players.includes(owner) ? this.team1!.players : this.team2!.players;
      // SUPPORT TRIANGLE: nearest two teammates create forward-left/right options, one drops behind
      const supports = sameTeam.filter(p => p.id !== owner!.id);
      const forwardDir = dir;
      supports.sort((a,b) => Math.hypot(a.position.x-owner!.position.x,a.position.y-owner!.position.y) - Math.hypot(b.position.x-owner!.position.x,b.position.y-owner!.position.y));
      const supA = supports[0];
      const supB = supports[1];
      const supC = supports[2];
      const applySupportMove = (pl: Player | undefined, tx: number, ty: number) => {
        if (!pl) return;
        const mx = (tx - pl.position.x) * 0.15;
        const my = (ty - pl.position.y) * 0.15;
        pl.position.x += mx;
        pl.position.y += my;
        pl.position.x = Math.max(30, Math.min(environment.gameSettings.fieldWidth - 30, pl.position.x));
        pl.position.y = Math.max(30, Math.min(environment.gameSettings.fieldHeight - 30, pl.position.y));
      };
      // Forward outlets
      applySupportMove(supA, owner.position.x + forwardDir * 55, owner.position.y - 38);
      applySupportMove(supB, owner.position.x + forwardDir * 55, owner.position.y + 38);
      // Recycle / safety outlet slightly behind
      applySupportMove(supC, owner.position.x - forwardDir * 42, owner.position.y + (owner.position.y < environment.gameSettings.fieldHeight/2 ? 20 : -20));
      if (now - this.possessionStartTime > this.maxPossessionMs) {
        const opponents: Player[] = sameTeam === this.team1!.players ? this.team2!.players : this.team1!.players;
        if (Math.random() < 0.5) {
          let turnoverOpp: Player | undefined; let bD = Infinity;
          for (const o of opponents) {
            const d = Math.hypot(o.position.x - owner!.position.x, o.position.y - owner!.position.y);
            if (d < bD) { bD = d; turnoverOpp = o; }
          }
          if (turnoverOpp) { this.gameState$.next({ ...state, currentBallOwner: turnoverOpp.id }); this.possessionStartTime = now; this.possessionLockOwner = turnoverOpp.id; this.possessionLockUntil = now + 700; return; }
        } else {
          const fieldW = environment.gameSettings.fieldWidth;
          const goalX = leftSide ? fieldW - 30 : 30;
          const targetX = owner.position.x + (goalX - owner.position.x) * 0.6;
          const targetY = owner.position.y + (Math.random() - 0.5) * 140;
          const dx = targetX - owner.position.x; const dy = targetY - owner.position.y; const dist = Math.hypot(dx, dy) || 1;
          const vx = (dx / dist) * speedCfg.passSpeed * 1.25; const vy = (dy / dist) * speedCfg.passSpeed * 1.25;
          this.gameState$.next({ ...state, ball: { ...ball, vx, vy }, currentBallOwner: null });
          // Attach extended metadata for forced long pass
          (this as any)._eventExtra = {
            startX: owner.position.x,
            startY: owner.position.y,
            endX: targetX,
            endY: targetY,
            role: owner.role,
            subtype: 'forced_long_pass',
            result: 'complete'
          };
          this.lastPassTime = now; this.generateGameEvent('pass', (sameTeam === this.team1.players ? this.team1.name : this.team2!.name), `${owner.name}⇢Long`); this.possessionStartTime = now + 400; return;
        }
      }
      const canAct = now - this.lastPassTime > this.passCooldown;
      if (canAct) {
        const goalX = leftSide ? environment.gameSettings.fieldWidth - 20 : 20;
        const distanceToGoal = Math.abs(goalX - owner.position.x);
        const goalMouthHalf = (environment.gameSettings.goalWidthM * (environment.gameSettings.fieldHeight - 20) / environment.gameSettings.pitchWidthM) / 2;
        const verticalOk = Math.abs(owner.position.y - environment.gameSettings.fieldHeight/2) < goalMouthHalf + 120;
        const staminaFactor = owner.abilities ? (0.5 + 0.5 * (owner.abilities.stamina / owner.abilities.maxStamina)) : 1;
        const powerFactor = owner.abilities ? (0.6 + owner.abilities.shotPower / 100 * 0.8) : 1;
        const accuracyFactor = owner.abilities ? (0.5 + owner.abilities.accuracy / 100 * 0.5) : 1;
        const shootProb = distanceToGoal < 110 ? 0.75 + (powerFactor - 1) * 0.22 : distanceToGoal < 170 ? 0.40 + (powerFactor - 1) * 0.15 : 0;
        if (shootProb > 0 && verticalOk && Math.random() < shootProb) {
          const aimSpread = goalMouthHalf * (1.2 - 0.7 * accuracyFactor);
          const targetY = environment.gameSettings.fieldHeight / 2 + (Math.random() - 0.5) * aimSpread;
          const dxShot = goalX - ball.x; const dyShot = targetY - ball.y; const dShot = Math.hypot(dxShot, dyShot) || 1;
          const shotSpeed = speedCfg.shotSpeed * powerFactor * staminaFactor;
          const vxShot = (dxShot / dShot) * shotSpeed; const vyShot = (dyShot / dShot) * shotSpeed;
          this.gameState$.next({ ...state, ball: { ...ball, vx: vxShot, vy: vyShot }, currentBallOwner: null });
          // Shot attempt metadata
          (this as any)._eventExtra = {
            startX: ball.x,
            startY: ball.y,
            endX: goalX,
            endY: targetY,
            role: owner.role,
            subtype: 'shot_attempt',
            result: 'attempt'
          };
          this.lastPassTime = now; this.generateGameEvent('shot', (this.team1.players.includes(owner) ? this.team1.name : this.team2!.name), owner.name); this.possessionStartTime = now; return;
        }
        const teammates = (this.team1.players.includes(owner) ? this.team1.players : this.team2.players).filter(p => p.id !== owner!.id);
        if (teammates.length) {
          const dirSign = leftSide ? 1 : -1;
          const forward: Player[] = []; const lateral: Player[] = []; const backward: Player[] = [];
          teammates.forEach(p => { const dxSide = (p.position.x - owner!.position.x) * dirSign; if (dxSide > 8) forward.push(p); else if (dxSide < -14) backward.push(p); else lateral.push(p); });
          forward.sort((a,b) => leftSide ? b.position.x - a.position.x : a.position.x - b.position.x);
          backward.sort((a,b) => Math.hypot(a.position.x-owner!.position.x,a.position.y-owner!.position.y) - Math.hypot(b.position.x-owner!.position.x,b.position.y-owner!.position.y));
          lateral.sort((a,b) => Math.hypot(a.position.x-owner!.position.x,a.position.y-owner!.position.y) - Math.hypot(b.position.x-owner!.position.x,b.position.y-owner!.position.y));
          let wF = 0.55, wL = 0.30, wB = 0.15;
          if (!forward.length) { wF = 0; wL = 0.55; wB = 0.45; }
          if (this.consecutiveNonAdvancingPasses >= 2) { wF += 0.25; wL += 0.10; wB *= 0.4; }
          const total = wF + wL + wB || 1; wF/=total; wL/=total; wB/=total;
          const r = Math.random();
          let chosen: Player[] = [];
          if (r < wF && forward.length) chosen = forward.slice(0,4); else if (r < wF + wL && lateral.length) chosen = lateral.slice(0,4); else chosen = (backward.length? backward.slice(0,4) : forward.slice(0,4));
          if (chosen.length) {
            let target: Player = chosen[0];
            if (chosen === forward && Math.random() < 0.5 && chosen.length > 1) target = chosen[Math.floor(Math.random()*chosen.length)];
            const passPowerFactor = owner!.abilities ? (0.5 + owner!.abilities.passPower / 100 * 0.9) : 1;
            const passAccFactor = owner!.abilities ? (0.5 + owner!.abilities.accuracy / 100 * 0.5) : 1;
            let passSpeed = speedCfg.passSpeed * passPowerFactor;
            const leadBase = target.abilities ? (target.abilities.speedFactor * 4) : 2;
            const leadFactor = (chosen === forward) ? 1.0 : (chosen === lateral) ? 0.4 : 0.1;
            const lead = leadBase * leadFactor * dirSign;
            const targetX = target.position.x + lead;
            const targetY = target.position.y + (Math.random() - 0.5) * (18 / passAccFactor);
            const ndx = targetX - ball.x; const ndy = targetY - ball.y; const nd = Math.hypot(ndx, ndy) || 1;
            const vx = (ndx / nd) * passSpeed; const vy = (ndy / nd) * passSpeed;
            this.gameState$.next({ ...state, ball: { ...ball, vx, vy }, currentBallOwner: null });
            this.lastPassTime = now;
            const dirSymbol = (chosen === forward) ? '→' : (chosen === lateral) ? '↔' : '↩';
            // Pass metadata
            const passSubtype = (chosen === forward) ? 'forward_pass' : (chosen === lateral) ? 'lateral_pass' : 'backward_pass';
            (this as any)._eventExtra = {
              startX: owner!.position.x,
              startY: owner!.position.y,
              endX: target.position.x,
              endY: target.position.y,
              role: owner!.role,
              subtype: passSubtype,
              result: 'complete'
            };
            this.generateGameEvent('pass', (this.team1.players.includes(owner) ? this.team1.name : this.team2!.name), `${owner!.name}${dirSymbol}${target.name}`);
            const forwardDelta = dirSign * (target.position.x - owner!.position.x);
            if (forwardDelta > 14) this.consecutiveNonAdvancingPasses = 0; else this.consecutiveNonAdvancingPasses++;
            this.possessionStartTime = now; return;
          }
        }
      }
    }
    if (newOwner !== state.currentBallOwner) { this.gameState$.next({ ...state, currentBallOwner: newOwner }); }
  }


  private lastFoulTime = 0;
  private foulCooldownMs = 4000;
  private generateRandomEvents(): void {
    if (!this.team1 || !this.team2) return;
    const now = Date.now();
    const everyone = [...this.team1.players, ...this.team2.players];

    // Collision-based foul chance with cooldown and velocity component to reduce spam
    // Suppress fouls in opening moments to avoid clustered whistle spam
    const elapsedSim = this.gameDuration - this.gameState$.value.timeRemaining;
    if (elapsedSim > 3 && (now - this.lastFoulTime > this.foulCooldownMs)) {
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
            // After offside, perform restart so ball re-enters play (simple throw-in style for now)
            this.handleOffsideRestart(offender, offenderTeam);
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

    // Allow extended metadata via a temporary stash object placed on (this as any)._eventExtra before call
    const extra = (this as any)._eventExtra || {};
    delete (this as any)._eventExtra;
    const classifyZone = (x: number, y: number): string => {
      const fw = environment.gameSettings.fieldWidth;
      const fh = environment.gameSettings.fieldHeight;
      const thirdW = fw / 3;
      let zone: string = 'middle_third';
      if (x < thirdW) zone = 'defensive_third'; else if (x > 2 * thirdW) zone = 'attacking_third';
      const flankMargin = fh * 0.20;
      if (y < flankMargin) zone += '_top_flank'; else if (y > fh - flankMargin) zone += '_bottom_flank'; else zone += '_central';
      return zone;
    };
    const zoneStart = (extra.startX !== undefined && extra.startY !== undefined) ? classifyZone(extra.startX, extra.startY) : undefined;
    const zoneEnd = (extra.endX !== undefined && extra.endY !== undefined) ? classifyZone(extra.endX, extra.endY) : undefined;
    const event: GameEvent = {
      time: elapsedTime,
      type: type as any,
      team: teamName,
      player: playerName,
      description: this.getEventDescription(type, playerName, teamName),
      displayTime,
      realMinute,
      startX: extra.startX,
      startY: extra.startY,
      endX: extra.endX,
      endY: extra.endY,
      result: extra.result,
      role: extra.role,
      subtype: extra.subtype,
      zoneStart,
      zoneEnd
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
      shot: `🎯 ${playerName} takes a shot!`,
      coin_toss: `🪙 Coin toss: ${teamName} will kick off the match!`,
      kickoff: `🔔 Kickoff by ${playerName} for ${teamName}.`
    };

    return events[eventType as keyof typeof events] || `${playerName} is involved in the action!`;
  }

  // Throw-in handler (saque de banda)
  private handleThrowIn(x: number, y: number): void {
    if (!this.team1 || !this.team2) return;
    const gs = this.gameState$.value;
    const fieldH = environment.gameSettings.fieldHeight;
    const fieldW = environment.gameSettings.fieldWidth;
    const inFieldY = y < fieldH / 2 ? 30 : fieldH - 30;
    const inFieldX = Math.max(40, Math.min(fieldW - 40, x));
    const allPlayers = [...this.team1.players, ...this.team2.players];
    const lastId = this.recentOwners.length ? this.recentOwners[this.recentOwners.length - 1] : null;
    const lastPlayer = lastId ? allPlayers.find(p => p.id === lastId) : null;
    const throwTeam = lastPlayer ? (this.team1.players.includes(lastPlayer) ? this.team2! : this.team1!) : this.team1!;
    // Choose nearest player from throwTeam to restart
    let taker = throwTeam.players[0];
    let bestD = Infinity;
    for (const p of throwTeam.players) {
      const d = Math.hypot(p.position.x - inFieldX, p.position.y - inFieldY);
      if (d < bestD) { bestD = d; taker = p; }
    }
    this.gameState$.next({ ...gs, ball: { x: inFieldX, y: inFieldY, vx: 0, vy: 0 }, currentBallOwner: taker.id });
    (this as any)._eventExtra = {
      startX: inFieldX,
      startY: inFieldY,
      endX: inFieldX,
      endY: inFieldY,
      role: taker.role,
      subtype: 'throw_in',
      result: 'restart'
    };
    this.generateGameEvent('throw_in', throwTeam.name, taker.name);
  }

  private handleOffsideRestart(offender: Player, offenderTeam: Team): void {
    if (!this.team1 || !this.team2) return;
    const defendingTeam = this.team1.players.includes(offender) ? this.team2! : this.team1!;
    const attackDir = this.team1.players.includes(offender) ? 1 : -1;
    const restartX = Math.max(40, Math.min(environment.gameSettings.fieldWidth - 40, offender.position.x - 30 * attackDir));
    const restartY = offender.position.y;
    // Pick nearest defender to restart
    let taker = defendingTeam.players[0];
    let bestD = Infinity;
    for (const p of defendingTeam.players) {
      const d = Math.hypot(p.position.x - restartX, p.position.y - restartY);
      if (d < bestD) { bestD = d; taker = p; }
    }
    const gs = this.gameState$.value;
    this.gameState$.next({ ...gs, ball: { x: restartX, y: restartY, vx: 0, vy: 0 }, currentBallOwner: taker.id });
    (this as any)._eventExtra = {
      startX: restartX,
      startY: restartY,
      endX: restartX,
      endY: restartY,
      role: taker.role,
      subtype: 'offside_restart',
      result: 'restart'
    };
    // Use throw_in event label per user request for visible restart (could be free_kick in real rules)
    this.generateGameEvent('throw_in', defendingTeam.name, taker.name);
  }
}