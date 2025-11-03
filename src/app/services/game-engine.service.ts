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
    events: []
  });

  private gameEvents$ = new Subject<GameEvent>();
  private animationFrameId: number | null = null;
  private gameTimer: number | null = null;
  private lastTime = 0;

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

    // Initialize player positions
    this.initializePlayerPositions();

    // Reset game state
    const initialState: GameState = {
      isRunning: true,
      timeRemaining: duration,
      score: { team1: 0, team2: 0 },
      ball: { x: 450, y: 300, vx: Math.random() * 4 - 2, vy: Math.random() * 4 - 2 },
      events: []
    };

    this.gameState$.next(initialState);

    // Start game loop
    this.lastTime = Date.now();
    this.startGameLoop();
    this.startGameTimer();

    // Add game start event
    this.generateGameEvent('substitution', 'Game Start', 'The match begins!');
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

    // Position team 1 players (left side)
    this.team1.players.forEach((player, index) => {
      switch (player.role) {
        case 'goalkeeper':
          player.position = { x: 60, y: fieldHeight / 2 };
          break;
        case 'defender':
          player.position = { 
            x: 150 + (index % 2) * 60, 
            y: 150 + (index % 3) * 120 
          };
          break;
        case 'midfielder':
          player.position = { 
            x: 280 + (index % 2) * 60, 
            y: 120 + (index % 3) * 140 
          };
          break;
        case 'forward':
          player.position = { 
            x: 380 + (index % 2) * 60, 
            y: 200 + (index % 2) * 200 
          };
          break;
      }
    });

    // Position team 2 players (right side)
    this.team2.players.forEach((player, index) => {
      switch (player.role) {
        case 'goalkeeper':
          player.position = { x: fieldWidth - 60, y: fieldHeight / 2 };
          break;
        case 'defender':
          player.position = { 
            x: fieldWidth - 150 - (index % 2) * 60, 
            y: 150 + (index % 3) * 120 
          };
          break;
        case 'midfielder':
          player.position = { 
            x: fieldWidth - 280 - (index % 2) * 60, 
            y: 120 + (index % 3) * 140 
          };
          break;
        case 'forward':
          player.position = { 
            x: fieldWidth - 380 - (index % 2) * 60, 
            y: 200 + (index % 2) * 200 
          };
          break;
      }
    });
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
    this.updateBallPosition();

    // Update player positions
    this.updatePlayerPositions();

    // Generate random events
    this.generateRandomEvents();
  }

  private updateBallPosition(): void {
    const currentState = this.gameState$.value;
    const fieldWidth = environment.gameSettings.fieldWidth;
    const fieldHeight = environment.gameSettings.fieldHeight;

    let ball = { ...currentState.ball };

    // Apply physics
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Bounce off walls
    if (ball.x <= 20 || ball.x >= fieldWidth - 20) {
      ball.vx *= -0.8;
      ball.x = Math.max(20, Math.min(fieldWidth - 20, ball.x));
    }
    
    if (ball.y <= 20 || ball.y >= fieldHeight - 20) {
      ball.vy *= -0.8;
      ball.y = Math.max(20, Math.min(fieldHeight - 20, ball.y));
    }

    // Add some randomness
    ball.vx += (Math.random() - 0.5) * 0.2;
    ball.vy += (Math.random() - 0.5) * 0.2;

    // Limit speed
    const maxSpeed = 3;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed > maxSpeed) {
      ball.vx = (ball.vx / speed) * maxSpeed;
      ball.vy = (ball.vy / speed) * maxSpeed;
    }

    // Apply friction
    ball.vx *= 0.99;
    ball.vy *= 0.99;

    this.gameState$.next({
      ...currentState,
      ball
    });
  }

  private updatePlayerPositions(): void {
    if (!this.team1 || !this.team2) return;

    const currentState = this.gameState$.value;
    const ballPos = currentState.ball;

    // Simple AI: players move towards ball with some randomness
    [...this.team1.players, ...this.team2.players].forEach(player => {
      if (player.role !== 'goalkeeper') {
        const dx = ballPos.x - player.position.x;
        const dy = ballPos.y - player.position.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > 50) { // Don't crowd the ball
          const speed = 0.5 + Math.random() * 0.5;
          const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.5;
          
          player.position.x += Math.cos(angle) * speed;
          player.position.y += Math.sin(angle) * speed;

          // Keep players on field
          const fieldWidth = environment.gameSettings.fieldWidth;
          const fieldHeight = environment.gameSettings.fieldHeight;
          player.position.x = Math.max(30, Math.min(fieldWidth - 30, player.position.x));
          player.position.y = Math.max(30, Math.min(fieldHeight - 30, player.position.y));
        }
      }
    });
  }

  private generateRandomEvents(): void {
    if (Math.random() < 0.0015) { // Adjusted probability
      const eventTypes = ['goal', 'foul', 'corner', 'offside', 'yellow_card'];
      const weights = [1, 3, 2, 2, 1]; // Goal is less likely but more exciting
      
      let totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      let random = Math.random() * totalWeight;
      
      let eventType = eventTypes[0];
      for (let i = 0; i < eventTypes.length; i++) {
        if (random < weights[i]) {
          eventType = eventTypes[i];
          break;
        }
        random -= weights[i];
      }
      
      const team = Math.random() < 0.5 ? this.team1 : this.team2;
      if (team) {
        const player = team.players[Math.floor(Math.random() * team.players.length)];
        this.generateGameEvent(eventType, team.name, player.name);

        if (eventType === 'goal') {
          this.updateScore(team.id === this.team1?.id ? 'team1' : 'team2');
          // Reset ball position after goal
          this.resetBallPosition();
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

    const event: GameEvent = {
      time: elapsedTime,
      type: type as any,
      team: teamName,
      player: playerName,
      description: this.getEventDescription(type, playerName, teamName)
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