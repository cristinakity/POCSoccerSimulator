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
  phase?: 'pregame' | 'kickoff' | 'inplay' | 'finished';
  kickoffTeamName?: string | null;
}

@Injectable({ providedIn: 'root' })
export class GameEngineService {
  // ---------- Reactive state ----------
  private gameState$ = new BehaviorSubject<GameState>({
    isRunning: false,
    timeRemaining: 0,
    score: { team1: 0, team2: 0 },
    ball: { x: environment.gameSettings.fieldWidth / 2, y: environment.gameSettings.fieldHeight / 2, vx: 0, vy: 0 },
    events: [],
    currentBallOwner: null,
    phase: 'pregame',
    kickoffTeamName: null
  });
  private gameEvents$ = new Subject<GameEvent>();

  // ---------- Loop & timers ----------
  private animationFrameId: number | null = null;
  private gameTimer: any | null = null;
  private lastTime = 0;
  private lastDecisionTime = 0;

  // ---------- Possession / passing ----------
  private lastPassTime = 0;
  private passCooldown = 2500;
  private possessionLockOwner: string | null = null;
  private possessionLockUntil = 0;
  private possessionStartTime = 0;
  private consecutiveNonAdvancingPasses = 0;
  private friendlyContestGraceUntil = 0;

  // ---------- Teams / match meta ----------
  private team1: Team | null = null;
  private team2: Team | null = null;
  private gameDuration = environment.gameSettings.defaultGameDuration;
  private restartGraceUntil = 0;
  private rngState = 1;
  private momentumCounter = 0;
  private lastShooter: Player | null = null;
  private lastTouchTeam: 'team1' | 'team2' | null = null;
  private lastFoulTime = 0;

  // ---------- Public streams ----------
  getGameState(): Observable<GameState> { return this.gameState$.asObservable(); }
  getGameEvents(): Observable<GameEvent> { return this.gameEvents$.asObservable(); }

  // -------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------
  startGame(team1: Team, team2: Team, duration: number = this.gameDuration): void {
    this.team1 = team1; this.team2 = team2; this.gameDuration = duration;
    this.ensureDistinctTeamColors();
    this.initializePlayerPositions();
    this.seedRng(team1, team2, duration);

    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    this.gameState$.next({
      isRunning: false,
      timeRemaining: duration,
      score: { team1: 0, team2: 0 },
      ball: { x: fieldW / 2, y: fieldH / 2, vx: 0, vy: 0 },
      events: [],
      currentBallOwner: null,
      phase: 'pregame',
      kickoffTeamName: null
    });

    // Coin toss (deterministic)
    const coinWinner = this.rand() < 0.5 ? this.team1! : this.team2!;
    this.gameState$.next({ ...this.gameState$.value, kickoffTeamName: coinWinner.name });
    this.emitEvent('coin_toss', coinWinner.name, 'Referee');

    // Pick kickoff player (midfielder closest to center)
    const mids = coinWinner.players.filter(p => p.role === 'midfielder');
    const kickoffPlayer = mids.sort((a,b)=> Math.hypot(a.position.x - fieldW/2, a.position.y - fieldH/2) - Math.hypot(b.position.x - fieldW/2, b.position.y - fieldH/2))[0] || coinWinner.players[0];
    if (kickoffPlayer) {
      kickoffPlayer.position.x = fieldW/2 - (this.team1 === coinWinner ? 8 : -8);
      kickoffPlayer.position.y = fieldH/2;
      this.gameState$.next({ ...this.gameState$.value, currentBallOwner: kickoffPlayer.id, phase: 'kickoff' });
      this.possessionStartTime = Date.now();
      this.possessionLockOwner = kickoffPlayer.id;
      this.possessionLockUntil = Date.now() + 600;
    }

    this.lastTime = Date.now();
    this.lastDecisionTime = this.lastTime;
    this.lastPassTime = this.lastTime;
    this.passCooldown = 1600; // encourage initial activity

    this.startGameLoop();
    setTimeout(() => {
      const gs = this.gameState$.value;
      if (gs.phase === 'kickoff') {
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
          this.updatePlayers(delta);
          this.updatePossessionAndPassing(now);
          this.generateRandomEvents(now);
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
        return;
      }
      const next = gs.timeRemaining - 1;
      const halfMark = Math.floor(this.gameDuration / 2);
      if (this.gameDuration >= 60 && gs.phase === 'inplay' && next === halfMark) {
        this.enterHalftime();
      } else {
        this.gameState$.next({ ...gs, timeRemaining: next });
      }
    }, 1000);
  }

  private enterHalftime(): void {
    const gs = this.gameState$.value;
    this.gameState$.next({ ...gs, isRunning: false, phase: 'pregame' });
    const fieldW = environment.gameSettings.fieldWidth;
    [...(this.team1?.players||[]), ...(this.team2?.players||[])].forEach(p => {
      p.position.x = fieldW - p.position.x;
      if ((p as any).basePosition) (p as any).basePosition.x = fieldW - (p as any).basePosition.x;
    });
    setTimeout(() => {
      const cur = this.gameState$.value;
      if (cur.phase === 'pregame') {
        this.gameState$.next({
          ...cur,
          ball: { x: fieldW/2, y: environment.gameSettings.fieldHeight/2, vx: 0, vy: 0 },
          currentBallOwner: null,
          isRunning: true,
          phase: 'inplay'
        });
        this.restartGraceUntil = Date.now() + 1500;
      }
    }, 2500);
  }

  // -------------------------------------------------
  // Mechanics
  // -------------------------------------------------
  private updateBall(delta: number): void {
    const gs = this.gameState$.value;
    let { x, y, vx, vy } = gs.ball;
    if (gs.currentBallOwner) {
      const owner = this.findPlayer(gs.currentBallOwner);
      if (owner) { x = owner.position.x; y = owner.position.y; vx = 0; vy = 0; }
    } else {
      x += vx; y += vy;
      let friction = environment.gameSettings.speed.frictionFree;
      if (environment.gameSettings.weather === 'rain') friction *= 0.992;
      if (environment.gameSettings.weather === 'heat') friction *= 0.986;
      if (environment.gameSettings.ballDecayFree) friction = environment.gameSettings.ballDecayFree;
      vx *= friction; vy *= friction;
      if (Math.abs(vx) < 0.04) vx = 0;
      if (Math.abs(vy) < 0.04) vy = 0;

      const fieldW = environment.gameSettings.fieldWidth;
      const fieldH = environment.gameSettings.fieldHeight;
      if (y < 5 || y > fieldH - 5) { this.handleThrowIn(x, y); return; }

      const goalHalfPx = (environment.gameSettings.goalWidthM * (fieldH - 20) / environment.gameSettings.pitchWidthM) / 2;
      const inAperture = Math.abs(y - fieldH / 2) <= goalHalfPx;
      const crossedLeft = x < 5; const crossedRight = x > fieldW - 5;
      if ((crossedLeft || crossedRight)) {
        const scoringRef = crossedRight ? 'team1' : 'team2';
        const defendingRef = crossedRight ? 'team2' : 'team1';
        if (inAperture) {
          this.updateScore(scoringRef as 'team1'|'team2');
          (this as any)._eventExtra = { startX: x, startY: y, endX: x, endY: y, subtype: 'goal', result: 'goal' };
          const scorerName = this.lastShooter?.name || 'Unknown';
          const teamName = scoringRef === 'team1' ? this.team1?.name || 'Team 1' : this.team2?.name || 'Team 2';
          this.momentumCounter = 0;
          this.emitEvent('goal', teamName, scorerName);
          this.centerBall();
          this.restartGraceUntil = Date.now() + 1500;
          return;
        } else {
          const isGoalKick = (this.lastTouchTeam === scoringRef);
          if (isGoalKick) {
            this.performGoalKick(defendingRef as 'team1'|'team2', crossedLeft ? 'left':'right');
          } else {
            const attackingObj = scoringRef === 'team1' ? this.team1! : this.team2!;
            this.performCorner(attackingObj, crossedLeft ? 'left':'right', y < fieldH/2 ? 'top':'bottom');
          }
          this.restartGraceUntil = Date.now() + 1500;
          return;
        }
      }
    }
    this.gameState$.next({ ...gs, ball: { x, y, vx, vy } });
  }

  private updatePlayers(delta: number): void {
    if (!this.team1 || !this.team2) return;
    const gs = this.gameState$.value;
    const ball = gs.ball;
    const all = [...this.team1.players, ...this.team2.players];
    const dt = delta / 16.67;
    const baseMove = environment.gameSettings.speed.playerBase * dt;

    const ownerId = gs.currentBallOwner;
    const ballOwner = ownerId ? this.findPlayer(ownerId) : undefined;

    const chasers = [...all].sort((a,b) => this.dist(a, ball) - this.dist(b, ball)).slice(0,4);

    all.forEach(p => {
      if (p.abilities) {
        const moveFactor = chasers.includes(p) ? 1.0 : 0.35;
        const decay = 0.0025 * dt * moveFactor;
        p.abilities.stamina = Math.max(0, p.abilities.stamina - decay);
        if (!ballOwner && p.abilities.stamina < p.abilities.maxStamina * 0.75) {
          p.abilities.stamina = Math.min(p.abilities.maxStamina, p.abilities.stamina + 0.0012 * dt * p.abilities.maxStamina);
        }
      }
      if (p.role === 'goalkeeper') {
        const goalX = this.team1.players.includes(p) ? 50 : environment.gameSettings.fieldWidth - 50;
        const targetY = Math.max(50, Math.min(environment.gameSettings.fieldHeight - 50, ball.y + ball.vy * 4));
        p.position.x += (goalX - p.position.x) * 0.05 * baseMove;
        p.position.y += (targetY - p.position.y) * 0.06 * baseMove;
        return;
      }
      const basePos = (p as any).basePosition || p.position;
      const dx = ball.x - p.position.x;
      const dy = ball.y - p.position.y;
      const distToBall = Math.hypot(dx, dy);
      const staminaFactor = p.abilities ? (0.5 + 0.5 * (p.abilities.stamina / p.abilities.maxStamina)) : 1;
      const speedFactor = p.abilities ? p.abilities.speedFactor : 1;
      const chaseSpeed = baseMove * speedFactor * staminaFactor * (chasers.includes(p) ? 1.25 : 0.35);

      let jitterX = (this.rand() - 0.5) * 0.07 * baseMove;
      let jitterY = (this.rand() - 0.5) * 0.07 * baseMove;

      if (!chasers.includes(p)) {
        if (!(p as any)._laneTarget) (p as any)._laneTarget = { x: basePos.x, y: basePos.y };
        const tgt = (p as any)._laneTarget;
        if (!(p as any)._laneRecalc || Date.now() > (p as any)._laneRecalc) {
          const dir = this.team1.players.includes(p) ? 1 : -1;
          const forwardBias = p.role === 'forward' ? 65 : p.role === 'midfielder' ? 40 : 20;
          tgt.x = basePos.x + dir * this.rand() * forwardBias;
          tgt.y = basePos.y + (this.rand() - 0.5) * 50;
          (p as any)._laneRecalc = Date.now() + 1200 + this.rand() * 1800;
        }
        jitterX += (tgt.x - p.position.x) * 0.012 * baseMove;
        jitterY += (tgt.y - p.position.y) * 0.012 * baseMove;
      }

      if (distToBall > 26) {
        const ang = Math.atan2(dy, dx);
        p.position.x += Math.cos(ang) * chaseSpeed + jitterX;
        p.position.y += Math.sin(ang) * chaseSpeed + jitterY;
      } else {
        p.position.x += (basePos.x - p.position.x) * 0.05 * baseMove + jitterX;
        p.position.y += (basePos.y - p.position.y) * 0.05 * baseMove + jitterY;
      }

      p.position.x = Math.max(30, Math.min(environment.gameSettings.fieldWidth - 30, p.position.x));
      p.position.y = Math.max(30, Math.min(environment.gameSettings.fieldHeight - 30, p.position.y));
    });
  }

  private updatePossessionAndPassing(now: number): void {
    if (!this.team1 || !this.team2) return;
    const gs = this.gameState$.value;
    const ball = gs.ball;
    const all = [...this.team1.players, ...this.team2.players];
    const possessionRadius = 18;

    let owner: Player | null = null;
    let newOwner: string | null = gs.currentBallOwner;

    if (gs.currentBallOwner) {
      owner = this.findPlayer(gs.currentBallOwner) || null;
      if (owner && now > this.possessionLockUntil) {
        const ownerTeamIs1 = this.team1.players.includes(owner);
        const opponents = ownerTeamIs1 ? this.team2.players : this.team1.players;
        let closestOpp: Player | undefined; let best = Infinity;
        for (const o of opponents) {
          const d = Math.hypot(o.position.x - ball.x, o.position.y - ball.y);
          if (d < possessionRadius && d < best) { best = d; closestOpp = o; }
        }
        if (closestOpp) {
          const atkStam = closestOpp.abilities?.stamina ?? 50;
          const defStam = owner.abilities?.stamina ?? 50;
          const baseSteal = 0.28 + Math.max(-0.15, Math.min(0.25, (atkStam - defStam) / 160));
          const heldMs = now - this.possessionStartTime;
          const durationBoost = Math.min(0.22, heldMs / 6000 * 0.22);
          const fatigueBoost = owner.abilities ? (1 - owner.abilities.stamina / owner.abilities.maxStamina) * 0.18 : 0;
          const rawChance = baseSteal + durationBoost + fatigueBoost;
          const ax = owner.position.x - closestOpp.position.x;
          const ay = owner.position.y - closestOpp.position.y;
          const approachAngle = Math.atan2(ay, ax);
          const facing = (closestOpp as any).facing ?? approachAngle;
          const diff = Math.abs(((approachAngle - facing + Math.PI*3)%(Math.PI*2))-Math.PI);
          const angleBonus = diff < Math.PI/4 ? 0.10 : diff < Math.PI/2 ? 0.03 : -0.06;
          const finalChance = Math.min(0.95, Math.max(0.02, rawChance + angleBonus));
          if (this.rand() < finalChance) {
            (this as any)._eventExtra = { startX: ball.x, startY: ball.y, endX: ball.x, endY: ball.y, role: closestOpp.role, subtype: 'tackle', result: 'won' };
            const teamName = this.team1.players.includes(closestOpp) ? this.team1.name : this.team2.name;
            this.emitEvent('tackle', teamName, closestOpp.name);
            owner = closestOpp; newOwner = closestOpp.id;
            this.possessionLockOwner = newOwner; this.possessionLockUntil = now + 900; this.possessionStartTime = now; this.friendlyContestGraceUntil = now + 1200;
          }
        }
      }
    } else {
      let best = Infinity;
      for (const p of all) {
        const d = Math.hypot(p.position.x - ball.x, p.position.y - ball.y);
        if (d < possessionRadius && d < best) { best = d; owner = p; }
      }
      if (owner) {
        newOwner = owner.id; this.possessionLockOwner = newOwner; this.possessionLockUntil = now + 900; this.possessionStartTime = now; this.friendlyContestGraceUntil = now + 1200;
      }
    }

    if (owner) {
      const leftSide = this.team1.players.includes(owner);
      const dir = leftSide ? 1 : -1;
      owner.position.x += environment.gameSettings.speed.playerBase * 1.15 * dir;
      owner.position.x = Math.max(30, Math.min(environment.gameSettings.fieldWidth - 30, owner.position.x));

      const canAct = now - this.lastPassTime > this.passCooldown;
      if (canAct) {
        const teammates = (leftSide ? this.team1.players : this.team2.players).filter(p => p.id !== owner!.id);
        if (teammates.length) {
          const forward: Player[] = []; const lateral: Player[] = []; const backward: Player[] = [];
          teammates.forEach(p => { const dxSide = (p.position.x - owner!.position.x) * dir; if (dxSide > 10) forward.push(p); else if (dxSide < -16) backward.push(p); else lateral.push(p); });
          forward.sort((a,b) => leftSide ? b.position.x - a.position.x : a.position.x - b.position.x);
          lateral.sort((a,b) => this.dist(a, owner!) - this.dist(b, owner!));
          backward.sort((a,b) => this.dist(a, owner!) - this.dist(b, owner!));
          let wF = 0.55, wL = 0.30, wB = 0.15;
          if (!forward.length) { wF = 0; wL = 0.55; wB = 0.45; }
          if (this.consecutiveNonAdvancingPasses >= 2) { wF += 0.25; wL += 0.1; wB *= 0.4; }
          const total = wF + wL + wB; wF/=total; wL/=total; wB/=total;
          const r = this.rand();
          let chosenSet: Player[] = [];
          if (r < wF && forward.length) chosenSet = forward.slice(0,4); else if (r < wF + wL && lateral.length) chosenSet = lateral.slice(0,4); else chosenSet = backward.length ? backward.slice(0,4) : forward.slice(0,4);
          if (chosenSet.length) {
            let target = chosenSet[0];
            if (chosenSet === forward && this.rand() < 0.5 && chosenSet.length > 1) target = chosenSet[Math.floor(this.rand()*chosenSet.length)];
            const passPower = owner.abilities ? (0.5 + owner.abilities.passPower/100 * 0.9) : 1;
            const passAcc = owner.abilities ? (0.5 + owner.abilities.accuracy/100 * 0.5) : 1;
            const leadFactor = (chosenSet === forward ? 1.0 : chosenSet === lateral ? 0.4 : 0.1) * dir * (target.abilities?.speedFactor ?? 1) * 4;
            const targetX = target.position.x + leadFactor;
            const targetY = target.position.y + (this.rand() - 0.5) * (18 / passAcc);
            const ndx = targetX - ball.x; const ndy = targetY - ball.y; const nd = Math.hypot(ndx, ndy) || 1;
            if (nd < 34) { this.lastPassTime = now + 300; return; }
            const passSpeed = environment.gameSettings.speed.passSpeed * passPower;
            const vx = (ndx / nd) * passSpeed; const vy = (ndy / nd) * passSpeed;
            if (Date.now() > this.restartGraceUntil) {
              const ownerIsTeam1 = leftSide;
              const defenders = ownerIsTeam1 ? this.team2.players.filter(p=>p.role !== 'goalkeeper') : this.team1.players.filter(p=>p.role !== 'goalkeeper');
              const secondLastX = this.secondLastDefenderX(defenders, ownerIsTeam1 ? 1 : -1);
              const inOppHalf = ownerIsTeam1 ? target.position.x > environment.gameSettings.fieldWidth/2 : target.position.x < environment.gameSettings.fieldWidth/2;
              const aheadBall = ownerIsTeam1 ? target.position.x > owner.position.x : target.position.x < owner.position.x;
              const aheadDef = ownerIsTeam1 ? target.position.x > secondLastX : target.position.x < secondLastX;
              if (inOppHalf && aheadBall && aheadDef) {
                (this as any)._eventExtra = { startX: owner.position.x, startY: owner.position.y, endX: target.position.x, endY: target.position.y, role: owner.role, subtype: 'offside', result: 'whistle' };
                this.emitEvent('offside', ownerIsTeam1 ? this.team1.name : this.team2!.name, target.name);
                this.handleOffsideRestart(target, ownerIsTeam1 ? this.team1! : this.team2!);
                return;
              }
            }
            const opponents = leftSide ? this.team2.players : this.team1.players;
            const arrivalTime = nd / passSpeed;
            const interceptor = this.findInterceptor(ball.x, ball.y, targetX, targetY, opponents, arrivalTime, environment.gameSettings.speed.playerBase);
            if (interceptor) {
              (this as any)._eventExtra = { startX: owner.position.x, startY: owner.position.y, endX: interceptor.position.x, endY: interceptor.position.y, role: interceptor.role, subtype: 'interception', result: 'intercepted' };
              this.emitEvent('interception', this.team1.players.includes(interceptor) ? this.team1.name : this.team2!.name, interceptor.name);
              this.gameState$.next({ ...gs, ball: { x: interceptor.position.x, y: interceptor.position.y, vx: 0, vy: 0 }, currentBallOwner: interceptor.id });
              this.possessionLockOwner = interceptor.id; this.possessionLockUntil = now + 600; this.possessionStartTime = now; this.lastTouchTeam = this.team1.players.includes(interceptor) ? 'team1':'team2';
              return;
            }
            this.gameState$.next({ ...gs, ball: { ...ball, vx, vy }, currentBallOwner: null });
            this.lastPassTime = now;
            (this as any)._eventExtra = { startX: owner.position.x, startY: owner.position.y, endX: target.position.x, endY: target.position.y, role: owner.role, subtype: chosenSet===forward?'forward_pass':chosenSet===lateral?'lateral_pass':'backward_pass', result: 'complete' };
            this.emitEvent('pass', leftSide ? this.team1.name : this.team2!.name, `${owner.name}→${target.name}`);
            this.lastTouchTeam = leftSide ? 'team1' : 'team2';
            const forwardDelta = dir * (target.position.x - owner.position.x);
            if (forwardDelta > 14) this.consecutiveNonAdvancingPasses = 0; else this.consecutiveNonAdvancingPasses++;
            this.possessionStartTime = now; return;
          }
        }
        const goalX = leftSide ? environment.gameSettings.fieldWidth - 20 : 20;
        const distGoal = Math.abs(goalX - owner.position.x);
        if (distGoal < 130 && this.rand() < 0.22) {
          const aimSpread = 30;
          const targetY = environment.gameSettings.fieldHeight/2 + (this.rand() - 0.5) * aimSpread;
          const dx = goalX - ball.x; const dy = targetY - ball.y; const d = Math.hypot(dx, dy) || 1;
          const shotSpeed = environment.gameSettings.speed.shotSpeed * 0.9;
          const vx = (dx/d) * shotSpeed; const vy = (dy/d) * shotSpeed;
          this.gameState$.next({ ...gs, ball: { ...ball, vx, vy }, currentBallOwner: null });
          (this as any)._eventExtra = { startX: ball.x, startY: ball.y, endX: goalX, endY: targetY, role: owner.role, subtype: 'shot_attempt', result: 'attempt' };
          this.lastShooter = owner; this.lastTouchTeam = leftSide ? 'team1' : 'team2';
          this.lastPassTime = now; this.emitEvent('shot', leftSide ? this.team1.name : this.team2!.name, owner.name); this.possessionStartTime = now; return;
        }
      }
    }

    if (newOwner !== gs.currentBallOwner) {
      this.gameState$.next({ ...gs, currentBallOwner: newOwner });
    } else if (newOwner === gs.currentBallOwner && now < this.friendlyContestGraceUntil) {
      this.possessionLockUntil = Math.max(this.possessionLockUntil, now + 300);
    }
  }

  private generateRandomEvents(now: number): void {
    if (!this.team1 || !this.team2) return;
    const elapsed = this.gameDuration - this.gameState$.value.timeRemaining;
    if (elapsed < 3) return;
    if (now - this.lastFoulTime > 4000) {
      const everyone = [...this.team1.players, ...this.team2.players];
      const collisions: Player[] = [];
      for (let i=0;i<everyone.length;i++) for (let j=i+1;j<everyone.length;j++) {
        const a = everyone[i]; const b = everyone[j];
        const same = (this.team1.players.includes(a) && this.team1.players.includes(b)) || (this.team2.players.includes(a) && this.team2.players.includes(b));
        if (same) continue;
        if (Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) < 16) collisions.push(a);
      }
      if (collisions.length && this.rand() < 0.18) {
        const offender = collisions[Math.floor(this.rand() * collisions.length)];
        const teamName = this.team1.players.includes(offender) ? this.team1.name : this.team2!.name;
        const cardRoll = this.rand();
        this.emitEvent(cardRoll > 0.93 ? 'yellow_card' : 'foul', teamName, offender.name);
        this.lastFoulTime = now;
      }
    }
  }

  // -------------------------------------------------
  // Events & descriptions
  // -------------------------------------------------
  private emitEvent(type: string, teamName: string, playerName: string): void {
    const gs = this.gameState$.value;
    const elapsed = this.gameDuration - gs.timeRemaining;
    const scale = 45 / this.gameDuration;
    const realFloat = elapsed * scale;
    const realMinute = Math.min(45, Math.floor(realFloat));
    const m = Math.floor(realFloat); const s = Math.floor((realFloat - m) * 60);
    const displayTime = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    const extra = (this as any)._eventExtra || {};
    delete (this as any)._eventExtra;

    const zoneOf = (x?:number,y?:number): string | undefined => {
      if (x==null||y==null) return undefined;
      const fw = environment.gameSettings.fieldWidth;
      const fh = environment.gameSettings.fieldHeight;
      let zone = 'middle_third';
      if (x < fw/3) zone = 'defensive_third'; else if (x > 2*fw/3) zone = 'attacking_third';
      const flank = fh * 0.20;
      if (y < flank) zone += '_top_flank'; else if (y > fh - flank) zone += '_bottom_flank'; else zone += '_central';
      return zone;
    };

    if (['pass','shot'].includes(type)) this.momentumCounter = Math.min(100, this.momentumCounter + (type==='shot'?4:1));
    if (type === 'goal') this.momentumCounter = 0;

    const event: GameEvent = {
      time: elapsed,
      type: type as any,
      team: teamName,
      player: playerName,
      description: this.describeEvent(type, playerName, teamName),
      displayTime,
      realMinute,
      startX: extra.startX,
      startY: extra.startY,
      endX: extra.endX,
      endY: extra.endY,
      result: extra.result,
      role: extra.role,
      subtype: extra.subtype,
      zoneStart: zoneOf(extra.startX, extra.startY),
      zoneEnd: zoneOf(extra.endX, extra.endY),
      momentumIndex: this.momentumCounter
    } as any;

    this.gameState$.next({ ...gs, events: [...gs.events, event] });
    this.gameEvents$.next(event);
  }

  private describeEvent(type: string, player: string, team: string): string {
    const dict: Record<string,string> = {
      goal: `⚽ Goal! ${player} scores for ${team}!`,
      foul: `⚠️ Foul by ${player}.`,
      corner: `🚩 Corner for ${team}.`,
      offside: `🚨 Offside: ${player}.`,
      yellow_card: `🟨 Yellow card for ${player}.`,
      pass: `➡️ Pass by ${player}.`,
      shot: `🎯 Shot attempt by ${player}.`,
      coin_toss: `🪙 ${team} wins the coin toss.`,
      kickoff: `🔔 Kickoff by ${player}.`,
      interception: `✂️ Interception by ${player}.`,
      tackle: `🛡️ Tackle won by ${player}.`,
      goal_kick: `🧤 Goal kick by ${player}.`,
      throw_in: `↔️ Throw-in by ${player}.`,
      penalty: `⚠️ Penalty – ${player} to take.`,
      save: `🧱 Save by ${player}!`
    };
    return dict[type] || `${player} in action.`;
  }

  private updateScore(team: 'team1'|'team2'): void {
    const gs = this.gameState$.value;
    const score = { ...gs.score }; score[team]++;
    this.gameState$.next({ ...gs, score });
  }

  // -------------------------------------------------
  // Restarts & set pieces
  // -------------------------------------------------
  private centerBall(): void {
    this.gameState$.next({ ...this.gameState$.value, ball: { x: environment.gameSettings.fieldWidth/2, y: environment.gameSettings.fieldHeight/2, vx: 0, vy: 0 }, currentBallOwner: null });
  }

  private performCorner(team: Team, side: 'left'|'right', quadrant: 'top'|'bottom'): void {
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    const x = side === 'left' ? 30 : fieldW - 30;
    const y = quadrant === 'top' ? 30 : fieldH - 30;
    let taker = team.players[0]; let best = Infinity;
    for (const p of team.players) { const d = Math.hypot(p.position.x - x, p.position.y - y); if (d < best) { best = d; taker = p; } }
    this.gameState$.next({ ...this.gameState$.value, ball: { x, y, vx: 0, vy: 0 }, currentBallOwner: taker.id });
    (this as any)._eventExtra = { startX: x, startY: y, endX: x, endY: y, role: taker.role, subtype: 'corner_kick', result: 'restart' };
    this.emitEvent('corner', team.name, taker.name);
    this.lastTouchTeam = team === this.team1 ? 'team1':'team2';
  }

  private performGoalKick(defTeam: 'team1'|'team2', side: 'left'|'right'): void {
    const team = defTeam === 'team1' ? this.team1! : this.team2!;
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    const x = side === 'left' ? 60 : fieldW - 60;
    const y = fieldH/2 + (this.rand() - 0.5) * 60;
    const keeper = team.players.find(p => p.role === 'goalkeeper') || team.players[0];
    this.gameState$.next({ ...this.gameState$.value, ball: { x, y, vx: 0, vy: 0 }, currentBallOwner: keeper.id });
    (this as any)._eventExtra = { startX: x, startY: y, endX: x, endY: y, role: keeper.role, subtype: 'goal_kick', result: 'restart' };
    this.emitEvent('goal_kick', team.name, keeper.name);
    this.lastTouchTeam = defTeam;
  }

  private handleThrowIn(x: number, y: number): void {
    if (!this.team1 || !this.team2) return;
    const fieldH = environment.gameSettings.fieldHeight;
    const fieldW = environment.gameSettings.fieldWidth;
    const inY = y < fieldH/2 ? 30 : fieldH - 30;
    const inX = Math.max(40, Math.min(fieldW - 40, x));
    const all = [...this.team1.players, ...this.team2.players];
    let nearest = all[0]; let best = Infinity;
    for (const p of all) { const d = Math.hypot(p.position.x - inX, p.position.y - inY); if (d < best) { best = d; nearest = p; } }
    this.gameState$.next({ ...this.gameState$.value, ball: { x: inX, y: inY, vx: 0, vy: 0 }, currentBallOwner: nearest.id });
    (this as any)._eventExtra = { startX: inX, startY: inY, endX: inX, endY: inY, role: nearest.role, subtype: 'throw_in', result: 'restart' };
    const teamName = this.team1.players.includes(nearest) ? this.team1.name : this.team2!.name;
    this.emitEvent('throw_in', teamName, nearest.name);
    this.restartGraceUntil = Date.now() + 1500;
  }

  private handleOffsideRestart(offender: Player, offenderTeam: Team): void {
    const defending = this.team1!.players.includes(offender) ? this.team2! : this.team1!;
    const dir = this.team1!.players.includes(offender) ? 1 : -1;
    const restartX = offender.position.x - 30 * dir;
    const restartY = offender.position.y;
    let taker = defending.players[0]; let best = Infinity;
    for (const p of defending.players) { const d = Math.hypot(p.position.x - restartX, p.position.y - restartY); if (d < best) { best = d; taker = p; } }
    this.gameState$.next({ ...this.gameState$.value, ball: { x: restartX, y: restartY, vx: 0, vy: 0 }, currentBallOwner: taker.id });
    (this as any)._eventExtra = { startX: restartX, startY: restartY, endX: restartX, endY: restartY, role: taker.role, subtype: 'offside_restart', result: 'restart' };
    this.emitEvent('throw_in', defending.name, taker.name); // using throw_in label for visibility
    this.restartGraceUntil = Date.now() + 1500;
  }

  // -------------------------------------------------
  // Setup & formation
  // -------------------------------------------------
  private ensureDistinctTeamColors(): void {
    if (!this.team1 || !this.team2) return;
    if (this.team1.color === this.team2.color) this.team2.color = this.team2.color === '#ff0000' ? '#0000ff' : '#ff0000';
  }

  private initializePlayerPositions(): void {
    if (!this.team1 || !this.team2) return;
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    const formations = [
      { defX: 0.18, midX: 0.42, fwdX: 0.68, defSpread: 0.42, midSpread: 0.50, fwdSpread: 0.55 },
      { defX: 0.20, midX: 0.45, fwdX: 0.70, defSpread: 0.48, midSpread: 0.58, fwdSpread: 0.70 },
      { defX: 0.22, midX: 0.48, fwdX: 0.72, defSpread: 0.46, midSpread: 0.60, fwdSpread: 0.40 },
      { defX: 0.26, midX: 0.50, fwdX: 0.74, defSpread: 0.55, midSpread: 0.62, fwdSpread: 0.58 },
      { defX: 0.16, midX: 0.40, fwdX: 0.66, defSpread: 0.50, midSpread: 0.46, fwdSpread: 0.30 },
      { defX: 0.24, midX: 0.50, fwdX: 0.70, defSpread: 0.50, midSpread: 0.65, fwdSpread: 0.38 }
    ];
    const place = (team: Team, left: boolean) => {
      const f = formations[Math.floor(this.rand() * formations.length)];
      const gk = team.players.find(p => p.role==='goalkeeper');
      const defenders = team.players.filter(p=>p.role==='defender');
      const mids = team.players.filter(p=>p.role==='midfielder');
      const fwds = team.players.filter(p=>p.role==='forward');
      const centerY = fieldH/2;
      const assignLine = (arr: Player[], depth: number, spread: number) => {
        if (!arr.length) return;
        arr.forEach((p,i)=>{
          const rel = arr.length===1?0:(i/(arr.length-1)-0.5);
          const y = centerY + rel * spread * fieldH + (this.rand()-0.5)*18;
          const xBase = depth * fieldW;
          p.position.x = (left? xBase : fieldW - xBase) + (this.rand()-0.5)*12;
          p.position.y = Math.max(40, Math.min(fieldH-40,y));
          (p as any).basePosition = { x: p.position.x, y: p.position.y };
        });
      };
      if (gk) {
        const gx = left ? 0.06*fieldW : fieldW - 0.06*fieldW;
        gk.position.x = gx; gk.position.y = centerY + (this.rand()-0.5)*28;
        (gk as any).basePosition = { x: gk.position.x, y: gk.position.y };
      }
      assignLine(defenders, f.defX, f.defSpread);
      assignLine(mids, f.midX, f.midSpread);
      assignLine(fwds, f.fwdX, f.fwdSpread);
    };
    place(this.team1, true);
    place(this.team2, false);
    const mid = fieldW/2;
    this.team1.players.forEach(p => { if (p.position.x > mid - 12) p.position.x = mid - 12; });
    this.team2.players.forEach(p => { if (p.position.x < mid + 12) p.position.x = mid + 12; });
  }

  // -------------------------------------------------
  // Utilities
  // -------------------------------------------------
  private findPlayer(id: string): Player | undefined { return [...(this.team1?.players||[]), ...(this.team2?.players||[])].find(p => p.id === id); }
  private dist(p: Player, ball: {x:number;y:number}): number { return Math.hypot(p.position.x - ball.x, p.position.y - ball.y); }
  private secondLastDefenderX(defs: Player[], dir: number): number {
    if (!defs.length) return dir===1?0:environment.gameSettings.fieldWidth;
    const xs = defs.map(d=>d.position.x).sort((a,b)=>a-b);
    return dir===1 ? (xs[xs.length-2] ?? xs[0]) : (xs[1] ?? xs[xs.length-1]);
  }
  private seedRng(t1: Team, t2: Team, dur: number): void {
    if (environment.gameSettings.randomSeed != null) {
      this.rngState = (environment.gameSettings.randomSeed >>> 0) || 1;
    } else {
      let acc = 0; const s = t1.name + t2.name + dur;
      for (let i=0;i<s.length;i++) acc = (acc*33 + s.charCodeAt(i)) >>> 0;
      this.rngState = acc || 1;
    }
  }
  private rand(): number { let t = this.rngState += 0x6D2B79F5; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }

  private findInterceptor(x0: number, y0: number, x1: number, y1: number, opponents: Player[], ballArrivalTime: number, baseSpeed: number): Player | null {
    let best: Player | null = null; let bestLead = Infinity;
    const segLen = Math.hypot(x1 - x0, y1 - y0) || 1;
    opponents.forEach(o => {
      const t = this.paramAlongSegment(o.position.x, o.position.y, x0, y0, x1, y1);
      const clampT = Math.max(0, Math.min(1, t));
      const px = x0 + (x1 - x0) * clampT;
      const py = y0 + (y1 - y0) * clampT;
      const distToCorridor = Math.hypot(o.position.x - px, o.position.y - py);
      if (distToCorridor > 40) return;
      const oppSpeed = baseSpeed * (o.abilities ? o.abilities.speedFactor : 1);
      const travelTime = distToCorridor / (oppSpeed + 0.01);
      if (travelTime < ballArrivalTime * 0.85 && travelTime < bestLead) { bestLead = travelTime; best = o; }
    });
    return best;
  }
  private paramAlongSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0; const dy = y1 - y0; const lenSq = dx*dx + dy*dy; if (!lenSq) return 0;
    return ((px - x0) * dx + (py - y0) * dy) / lenSq;
  }
}

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
    // Initialize deterministic RNG seed before any random decisions
    this.lastDecisionTime = Date.now();
    if (environment.gameSettings.randomSeed != null) {
      this.rngState = (environment.gameSettings.randomSeed >>> 0) || 1;
    } else {
      let acc = 0; const seedStr = team1.name + team2.name + duration;
      for (let i=0;i<seedStr.length;i++){ acc = (acc * 33 + seedStr.charCodeAt(i)) >>> 0; }
      this.rngState = acc || 1;
    }
    // Init heatmap grid (15x10)
    this.heatmap = Array.from({length:15},()=>Array(10).fill(0));
    // Coin toss determines kickoff (deterministic)
    const coinWinner = this.rand() < 0.5 ? this.team1! : this.team2!;
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
      { name: '5-3-2_block', defX: 0.16, midX: 0.40, fwdX: 0.66, defSpread: 0.50, midSpread: 0.46, fwdSpread: 0.30 },
      { name: '3-5-2_compact', defX: 0.24, midX: 0.50, fwdX: 0.70, defSpread: 0.50, midSpread: 0.65, fwdSpread: 0.38 }
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
    // Kickoff law compliance: ensure all players (except future kicker) start fully in their own half.
    const mid = fieldW / 2;
    this.team1.players.forEach(p => {
      if (p.position.x > mid - 12) {
        p.position.x = mid - 12;
        if ((p as any).basePosition) (p as any).basePosition.x = p.position.x;
      }
    });
    this.team2.players.forEach(p => {
      if (p.position.x < mid + 12) {
        p.position.x = mid + 12;
        if ((p as any).basePosition) (p as any).basePosition.x = p.position.x;
      }
    });
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
        if (now - this.lastDecisionTime >= environment.gameSettings.decisionIntervalMs) {
          this.lastDecisionTime = now;
          this.updatePlayerPositions(delta);
          this.updatePossessionAndPassing(delta);
          this.generateRandomEvents();
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
        // Match finished
        this.gameState$.next({ ...gs, phase: 'finished', isRunning: false, timeRemaining: 0 });
        this.stopGame();
      } else {
        const newTime = gs.timeRemaining - 1;
        // Halftime trigger (simple: midpoint of configured duration if > 60 real minutes target (i.e., 90 sim seconds))
        const halfMark = Math.floor(this.gameDuration / 2);
        // Only trigger halftime for matches representing two halves (>= 60 simulated seconds)
        if (this.gameDuration >= 60 && gs.phase === 'inplay' && newTime === halfMark) {
          this.enterHalftime();
        } else {
          this.gameState$.next({ ...gs, timeRemaining: newTime });
        }
      }
    }, 1000);
  }

  private enterHalftime(): void {
    const gs = this.gameState$.value;
    this.gameState$.next({ ...gs, phase: 'pregame', isRunning: false }); // reuse 'pregame' as paused state for brevity
    // Side switch: mirror all player x positions
    const fieldW = environment.gameSettings.fieldWidth;
    [...(this.team1?.players||[]), ...(this.team2?.players||[])].forEach(p => {
      p.position.x = fieldW - p.position.x;
      if ((p as any).basePosition) {
        (p as any).basePosition.x = fieldW - (p as any).basePosition.x;
      }
    });
    // Delay then restart second half
    setTimeout(() => {
      const cur = this.gameState$.value;
      if (cur.phase === 'pregame') {
        // Center ball, clear owner
        this.gameState$.next({
          ...cur,
          ball: { x: fieldW/2, y: environment.gameSettings.fieldHeight/2, vx: 0, vy: 0 },
          currentBallOwner: null,
          phase: 'inplay',
          isRunning: true
        });
        this.restartGraceUntil = Date.now() + 2000;
      }
    }, 2500);
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
      // Weather adjustments & optional overrides
      if (environment.gameSettings.weather === 'rain') { vx *= 0.992; vy *= 0.992; }
      if (environment.gameSettings.weather === 'heat') { vx *= 0.986; vy *= 0.986; }
      if (environment.gameSettings.ballDecayFree) {
        vx *= environment.gameSettings.ballDecayFree;
        vy *= environment.gameSettings.ballDecayFree;
      }
      if (Math.abs(vx) < 0.05) vx = 0; if (Math.abs(vy) < 0.05) vy = 0;
      // Out-of-bounds detection -> trigger throw-in restart ("saque de banda")
      const fieldW = environment.gameSettings.fieldWidth;
      const fieldH = environment.gameSettings.fieldHeight;
      const touchMargin = 5; // small margin beyond which we consider ball out
      if (y < touchMargin || y > fieldH - touchMargin) {
        this.handleThrowIn(x, y);
        return; // restart performed
      }
      // Goal / corner / goal kick detection when crossing goal lines
      const goalWidthM = environment.gameSettings.goalWidthM;
      const pitchWidthM = environment.gameSettings.pitchWidthM;
      const scaleY = (fieldH - 20) / pitchWidthM; // vertical scaling across drawable area
      const goalHalfPx = (goalWidthM * scaleY) / 2; // half aperture in px
      const goalCenterY = fieldH / 2;
      const inGoalAperture = Math.abs(y - goalCenterY) <= goalHalfPx;
      const crossedLeft = x < 5;
      const crossedRight = x > fieldW - 5;
      if (crossedLeft || crossedRight) {
        const scoringTeam = crossedRight ? 'team1' : 'team2'; // team1 attacks right, team2 attacks left
        const defendingTeam = crossedRight ? 'team2' : 'team1';
        if (inGoalAperture) {
          // Goal scored
          this.updateScore(scoringTeam as 'team1'|'team2');
          // Metadata for goal event
          (this as any)._eventExtra = {
            startX: x,
            startY: y,
            endX: x,
            endY: y,
            subtype: 'goal',
            result: 'goal'
          };
          const scorer = this.lastShooter || null;
          const teamName = scoringTeam === 'team1' ? this.team1?.name || 'Team 1' : this.team2?.name || 'Team 2';
          const playerName = scorer ? scorer.name : 'Unknown';
          this.generateGameEvent('goal', teamName, playerName);
          this.momentumCounter = 0; // reset momentum after goal
          this.resetForKickoff();
          this.restartGraceUntil = Date.now() + 2000;
          return;
        } else {
          // Corner or goal kick: determine last touch side
          const lastTouchTeam = this.lastTouchTeam || scoringTeam; // fallback
          const attackingTeam = scoringTeam === 'team1' ? (crossedRight ? 'team1' : 'team2') : (crossedLeft ? 'team2' : 'team1');
          // If last touch by attacker -> goal kick for defenders; else corner for attackers
          const isGoalKick = (lastTouchTeam === (scoringTeam === 'team1' ? 'team1' : 'team2'));
          if (isGoalKick) {
            this.performGoalKick(defendingTeam as 'team1'|'team2', crossedLeft ? 'left' : 'right');
          } else {
            this.performCorner(attackingTeam === 'team1' ? this.team1! : this.team2!, crossedLeft ? 'left' : 'right', y < goalCenterY ? 'top' : 'bottom');
          }
          this.restartGraceUntil = Date.now() + 2000;
          return;
        }
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
        // Stamina decay scaled with role & recent chase intensity; agility reduces effective decay slightly
        const chaseIntensity = Math.min(1, Math.hypot(ballPos.vx, ballPos.vy) / environment.gameSettings.speed.maxBallSpeed);
        const agilityFactor = player.abilities.agility ? (0.9 + (100 - player.abilities.agility) / 100 * 0.15) : 1;
        const decayBase = 0.002 * dtNorm * (player.role === 'midfielder' ? 1.15 : player.role === 'forward' ? 1.10 : 1);
        const decay = decayBase * (1 + 0.4 * chaseIntensity) * agilityFactor;
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
  const agilityMod = player.abilities ? (0.85 + player.abilities.agility / 100 * 0.3) : 1; // agility increases responsiveness
      // Enhanced defensive logic: if assigned presser / lane blocker give bespoke movement multipliers
      const isPrimaryPresser = primaryPresser === player;
      const isSecondaryBlocker = secondaryBlocker === player;
      const chaseMultiplier = isPrimaryPresser ? (1.35 + speedCfg.chaseExtra) : isSecondaryBlocker ? 0.95 : (isChasing ? (1 + speedCfg.chaseExtra) : 0.3);
      const chaseFactor = chaseMultiplier * baseMove * speedFactor * staminaFactor;
      const formationFactor = 0.06 * baseMove;
  let jitterX = (Math.random() - 0.5) * 0.08 * baseMove * agilityMod;
  let jitterY = (Math.random() - 0.5) * 0.08 * baseMove * agilityMod;
  // Replace random jitter with deterministic perception noise
  jitterX = (this.rand() - 0.5) * 0.08 * baseMove * agilityMod;
  jitterY = (this.rand() - 0.5) * 0.08 * baseMove * agilityMod;
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
          // Deterministic replacements
          tgt.x = base.x + dir * (this.rand() * forwardBias);
          tgt.y = base.y + (this.rand() - 0.5) * 50;
          (player as any)._laneRecalc = Date.now() + 1200 + this.rand() * 1800;
        }
        jitterX += (tgt.x - player.position.x) * 0.015 * baseMove;
        jitterY += (tgt.y - player.position.y) * 0.015 * baseMove;
      }
      }
    } else {
      let minD = Infinity;
      all.forEach(p => { const d = Math.hypot(p.position.x - ball.x, p.position.y - ball.y); if (d < possessionRadius && d < minD) { minD = d; owner = p; } });
  if (owner) { const o = owner as Player; newOwner = o.id; this.possessionLockOwner = newOwner; this.possessionLockUntil = now + 900; this.possessionStartTime = now; this.friendlyContestGraceUntil = now + 1200; }
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
          this.lastShooter = owner; // track for potential goal credit
          this.lastTouchTeam = this.team1!.players.includes(owner) ? 'team1' : 'team2';
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
            // If target extremely close, avoid pointless micro-pass that looks like teammates fighting
            if (nd < 34) { this.lastPassTime = now + 300; return; }
            const vx = (ndx / nd) * passSpeed; const vy = (ndy / nd) * passSpeed;
            // Offside check at pass moment (skip if within grace window)
            const ownerIsTeam1 = this.team1!.players.includes(owner!);
            if (Date.now() > this.restartGraceUntil) {
              const defenders = ownerIsTeam1 ? this.team2!.players.filter(p=>p.role!=='goalkeeper') : this.team1!.players.filter(p=>p.role!=='goalkeeper');
              const secondLastX = this.getSecondLastDefenderX(defenders, ownerIsTeam1 ? 1 : -1);
              const inOppHalf = ownerIsTeam1 ? target.position.x > environment.gameSettings.fieldWidth/2 : target.position.x < environment.gameSettings.fieldWidth/2;
              const aheadBall = ownerIsTeam1 ? target.position.x > owner!.position.x : target.position.x < owner!.position.x;
              const aheadDef = ownerIsTeam1 ? target.position.x > secondLastX : target.position.x < secondLastX;
              if (inOppHalf && aheadBall && aheadDef) {
                // Offside - emit event & restart, no pass executed
                (this as any)._eventExtra = {
                  startX: owner!.position.x,
                  startY: owner!.position.y,
                  endX: target.position.x,
                  endY: target.position.y,
                  role: owner!.role,
                  subtype: 'offside',
                  result: 'whistle'
                };
                const teamName = ownerIsTeam1 ? this.team1!.name : this.team2!.name;
                this.generateGameEvent('offside', teamName, target.name);
                this.handleOffsideRestart(target, ownerIsTeam1 ? this.team1! : this.team2!);
                return;
              }
            }
            // Interception pre-check: any opponent can reach corridor sooner than arrival time
            const opponentsForIntercept = ownerIsTeam1 ? this.team2!.players : this.team1!.players;
            const arrivalTimeBall = nd / passSpeed;
            const interceptor = this.findInterceptor(ball.x, ball.y, targetX, targetY, opponentsForIntercept, arrivalTimeBall, speedCfg.playerBase);
            if (interceptor) {
              // Interception event
              (this as any)._eventExtra = {
                startX: owner!.position.x,
                startY: owner!.position.y,
                endX: interceptor.position.x,
                endY: interceptor.position.y,
                role: interceptor.role,
                subtype: 'interception',
                result: 'intercepted'
              };
              const oppTeamName = this.team1!.players.includes(interceptor) ? this.team1!.name : this.team2!.name;
              this.generateGameEvent('interception', oppTeamName, interceptor.name);
              this.lastTouchTeam = this.team1!.players.includes(interceptor) ? 'team1' : 'team2';
              this.gameState$.next({ ...state, ball: { x: interceptor.position.x, y: interceptor.position.y, vx: 0, vy: 0 }, currentBallOwner: interceptor.id });
              this.possessionStartTime = now; this.possessionLockOwner = interceptor.id; this.possessionLockUntil = now + 600;
              return;
            }
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
            this.lastTouchTeam = ownerIsTeam1 ? 'team1' : 'team2';
            const forwardDelta = dirSign * (target.position.x - owner!.position.x);
            if (forwardDelta > 14) this.consecutiveNonAdvancingPasses = 0; else this.consecutiveNonAdvancingPasses++;
            this.possessionStartTime = now; return;
          }
        }
      }
    }
    if (newOwner !== state.currentBallOwner) { this.gameState$.next({ ...state, currentBallOwner: newOwner }); }
    // Extend lock slightly if friendly contest grace is active to reduce churn
    if (newOwner === state.currentBallOwner && now < this.friendlyContestGraceUntil) {
      this.possessionLockUntil = Math.max(this.possessionLockUntil, now + 300);
    }
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
      if (foulCandidates.length > 0 && this.rand() < 0.18) {
        const chosen = foulCandidates[Math.floor(Math.random() * foulCandidates.length)];
        const eventTypeRoll = this.rand();
        let ev: string = 'foul';
        if (eventTypeRoll > 0.93) ev = 'yellow_card';
        this.generateGameEvent(ev, chosen.team.name, chosen.offender.name);
        this.lastFoulTime = now;
        return;
      }
    }

    // Offside now handled contextually at pass moment; random generator removed.
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
    // Momentum heuristic: increment on attacking events
    if (['pass','shot'].includes(type)) this.momentumCounter = Math.min(100, this.momentumCounter + (type==='shot'?4:1));
    if (type === 'goal') this.momentumCounter = 0;
    (event as any).momentumIndex = this.momentumCounter;

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
      kickoff: `🔔 Kickoff by ${playerName} for ${teamName}.`,
      interception: `✂️ Interception! ${playerName} cuts out the pass.`,
      tackle: `🛡️ ${playerName} wins the ball with a tackle.`,
      goal_kick: `🧤 Goal kick taken by ${playerName}.`,
      throw_in: `↔️ Throw-in: ${playerName} restarts play.`,
      penalty: `⚠️ Penalty awarded – ${playerName} steps up.`,
      save: `🧱 Brilliant save by ${playerName}!`
    };

    return events[eventType as keyof typeof events] || `${playerName} is involved in the action!`;
  }

  // Track last shooter & touch for restart logic
  private lastShooter: Player | null = null;
  private lastTouchTeam: 'team1' | 'team2' | null = null;
  private resetForKickoff(): void {
    const gs = this.gameState$.value;
    // Center ball and null owner -> kickoff phase could be added later, for now immediate play restart
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    this.gameState$.next({
      ...gs,
      ball: { x: fieldW / 2, y: fieldH / 2, vx: 0, vy: 0 },
      currentBallOwner: null
    });
  }

  private performCorner(team: Team, side: 'left' | 'right', quadrant: 'top' | 'bottom'): void {
    const gs = this.gameState$.value;
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    const x = side === 'left' ? 30 : fieldW - 30;
    const y = quadrant === 'top' ? 30 : fieldH - 30;
    // Choose taker: nearest wide midfielder/winger preference else nearest player
    let taker: Player = team.players[0];
    let bestScore = Infinity;
    for (const p of team.players) {
      const dist = Math.hypot(p.position.x - x, p.position.y - y);
      if (dist < bestScore) { bestScore = dist; taker = p; }
    }
    this.gameState$.next({ ...gs, ball: { x, y, vx: 0, vy: 0 }, currentBallOwner: taker.id });
    (this as any)._eventExtra = {
      startX: x, startY: y, endX: x, endY: y, role: taker.role, subtype: 'corner_kick', result: 'restart'
    };
    this.generateGameEvent('corner', team.name, taker.name);
    this.lastTouchTeam = team === this.team1 ? 'team1' : 'team2';
  }

  private performGoalKick(defTeam: 'team1'|'team2', side: 'left'|'right'): void {
    const gs = this.gameState$.value;
    const team = defTeam === 'team1' ? this.team1! : this.team2!;
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    const x = side === 'left' ? 60 : fieldW - 60;
    const y = fieldH / 2 + (Math.random() - 0.5) * 80;
    const keeper = team.players.find(p => p.role === 'goalkeeper') || team.players[0];
    this.gameState$.next({ ...gs, ball: { x, y, vx: 0, vy: 0 }, currentBallOwner: keeper.id });
    (this as any)._eventExtra = {
      startX: x, startY: y, endX: x, endY: y, role: keeper.role, subtype: 'goal_kick', result: 'restart'
    };
    this.generateGameEvent('goal_kick', team.name, keeper.name);
    this.lastTouchTeam = defTeam;
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
    this.restartGraceUntil = Date.now() + 2000;
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
    this.restartGraceUntil = Date.now() + 2000;
  }

  // Utility: find second-last defender X (direction 1 means attacking to right)
  private getSecondLastDefenderX(defenders: Player[], dir: number): number {
    if (!defenders.length) return dir === 1 ? 0 : environment.gameSettings.fieldWidth;
    const xs = defenders.map(d => d.position.x).sort((a,b)=> a-b);
    // For attack to right, second last is penultimate highest; attack to left, second last is second smallest from right
    if (dir === 1) {
      return xs[xs.length - 2] || xs[0];
    } else {
      return xs[1] || xs[xs.length - 1];
    }
  }

  // Interception heuristic
  private findInterceptor(x0: number, y0: number, x1: number, y1: number, opponents: Player[], ballArrivalTime: number, baseSpeed: number): Player | null {
    let best: Player | null = null; let bestLead = Infinity;
    const segLen = Math.hypot(x1 - x0, y1 - y0) || 1;
    opponents.forEach(o => {
      const t = this.paramAlongSegment(o.position.x, o.position.y, x0, y0, x1, y1);
      const clampT = Math.max(0, Math.min(1, t));
      const px = x0 + (x1 - x0) * clampT;
      const py = y0 + (y1 - y0) * clampT;
      const distToCorridor = Math.hypot(o.position.x - px, o.position.y - py);
      if (distToCorridor > 40) return; // corridor width threshold
      const oppSpeed = baseSpeed * (o.abilities ? o.abilities.speedFactor : 1);
      const travelTime = distToCorridor / (oppSpeed + 0.01);
      if (travelTime < ballArrivalTime * 0.85 && travelTime < bestLead) {
        bestLead = travelTime; best = o;
      }
    });
    return best;
  }

  private paramAlongSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0; const dy = y1 - y0; const lenSq = dx*dx + dy*dy; if (!lenSq) return 0;
    return ((px - x0) * dx + (py - y0) * dy) / lenSq;
  }

  // Penalty setup (simplified)
  private setupPenaltyKick(attackingTeam: Team, ballX: number): void {
    const fieldW = environment.gameSettings.fieldWidth;
    const fieldH = environment.gameSettings.fieldHeight;
    const penaltySpotM = environment.gameSettings.penaltySpotDistM; // meters
    const scaleX = fieldW / environment.gameSettings.pitchLengthM;
    const spotOffsetPx = penaltySpotM * scaleX;
    const leftSide = ballX < fieldW/2; // penalty near left goal -> attackers shoot toward left goal
    const spotX = leftSide ? spotOffsetPx : fieldW - spotOffsetPx;
    const spotY = fieldH / 2;
    // Shooter: forward with highest shotPower
    const shooter = [...attackingTeam.players]
      .filter(p => p.role === 'forward')
      .sort((a,b) => (b.abilities?.shotPower||0) - (a.abilities?.shotPower||0))[0] || attackingTeam.players[0];
    this.gameState$.next({ ...this.gameState$.value, ball: { x: spotX, y: spotY, vx: 0, vy: 0 }, currentBallOwner: shooter.id });
    (this as any)._eventExtra = {
      startX: spotX,
      startY: spotY,
      endX: spotX,
      endY: spotY,
      role: shooter.role,
      subtype: 'penalty_awarded',
      result: 'restart'
    };
    this.generateGameEvent('penalty', attackingTeam.name, shooter.name);
    this.restartGraceUntil = Date.now() + 2500;
  }
  // Deterministic RNG (Mulberry32-like)
  private rand(): number {
    let t = this.rngState += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}