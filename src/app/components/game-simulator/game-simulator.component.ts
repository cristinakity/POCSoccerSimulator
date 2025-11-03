import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { TeamService, Team } from '../../services/team.service';
import { GameEngineService, GameState } from '../../services/game-engine.service';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'app-game-simulator',
  template: `
    <div class="controls">
      <div class="team-selector">
        <label for="team1">Team 1</label>
        <select id="team1" [(ngModel)]="selectedTeam1" [disabled]="isGameRunning">
          <option value="" disabled>Select Team 1</option>
          <option *ngFor="let team of availableTeams" [value]="team.id">
            {{team.name}}
          </option>
        </select>
      </div>

      <div class="duration-selector">
        <label for="duration">Duration (seconds)</label>
        <input 
          type="number" 
          id="duration" 
          [(ngModel)]="gameDuration" 
          [disabled]="isGameRunning"
          min="10" 
          max="300" 
          step="5"
        >
      </div>

      <div class="team-selector">
        <label for="team2">Team 2</label>
        <select id="team2" [(ngModel)]="selectedTeam2" [disabled]="isGameRunning">
          <option value="" disabled>Select Team 2</option>
          <option *ngFor="let team of availableTeams" [value]="team.id" [disabled]="team.id === selectedTeam1">
            {{team.name}}
          </option>
        </select>
      </div>
    </div>

    <div class="simulate-controls">
      <button 
        class="simulate-btn" 
        (click)="startSimulation()" 
        [disabled]="!canStartGame() || isGameRunning"
      >
        {{isGameRunning ? 'Game Running...' : 'Start Simulation'}}
      </button>
      
      <button 
        class="simulate-btn stop-btn" 
        (click)="stopSimulation()" 
        [disabled]="!isGameRunning"
        *ngIf="isGameRunning"
      >
        Stop Game
      </button>
    </div>

    <div class="timer" [class.finished]="gameState.timeRemaining === 0 && !isGameRunning">
      {{formatTime(gameState.timeRemaining)}}
    </div>

    <div class="game-area">
      <div class="field-container">
        <app-soccer-field 
          [team1]="getTeamById(selectedTeam1)" 
          [team2]="getTeamById(selectedTeam2)"
          [gameState]="gameState">
        </app-soccer-field>
      </div>
      
      <div class="game-info">
        <div class="score-board">
          <h3>Score</h3>
          <div class="score-display">
            <div class="team-score">
              <div class="team-name">{{getTeamById(selectedTeam1)?.name || 'Team 1'}}</div>
              <div class="score">{{gameState.score.team1}}</div>
            </div>
            <div class="vs">VS</div>
            <div class="team-score">
              <div class="team-name">{{getTeamById(selectedTeam2)?.name || 'Team 2'}}</div>
              <div class="score">{{gameState.score.team2}}</div>
            </div>
          </div>
        </div>
        
        <app-game-log [events]="gameState.events"></app-game-log>
      </div>
    </div>
  `,
  styles: [`
    .simulate-controls {
      display: flex;
      justify-content: center;
      gap: 15px;
      margin: 20px 0;
    }

    .stop-btn {
      background: linear-gradient(45deg, #dc3545, #c82333) !important;
    }

    .stop-btn:hover:not(:disabled) {
      background: linear-gradient(45deg, #c82333, #bd2130) !important;
    }
  `]
})
export class GameSimulatorComponent implements OnInit, OnDestroy {
  availableTeams: Team[] = [];
  selectedTeam1: string = '';
  selectedTeam2: string = '';
  gameDuration: number = environment.gameSettings.defaultGameDuration;
  isGameRunning: boolean = false;
  
  gameState: GameState = {
    isRunning: false,
    timeRemaining: 0,
    score: { team1: 0, team2: 0 },
    ball: { x: 450, y: 300, vx: 0, vy: 0 },
    events: [],
    currentBallOwner: null,
    phase: 'kickoff'
  };

  private subscriptions: Subscription[] = [];

  constructor(
    private teamService: TeamService,
    private gameEngine: GameEngineService
  ) {}

  ngOnInit(): void {
    this.availableTeams = this.teamService.generateRandomTeams();
    
    // Subscribe to game state changes
    this.subscriptions.push(
      this.gameEngine.getGameState().subscribe(state => {
        this.gameState = state;
        this.isGameRunning = state.isRunning;
      })
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.gameEngine.stopGame();
  }

  canStartGame(): boolean {
    return this.selectedTeam1 !== '' && 
           this.selectedTeam2 !== '' && 
           this.selectedTeam1 !== this.selectedTeam2 &&
           this.gameDuration >= 10;
  }

  startSimulation(): void {
    if (!this.canStartGame()) return;

    const team1 = this.getTeamById(this.selectedTeam1);
    const team2 = this.getTeamById(this.selectedTeam2);

    if (team1 && team2) {
      this.gameEngine.startGame(team1, team2, this.gameDuration);
    }
  }

  stopSimulation(): void {
    this.gameEngine.stopGame();
  }

  getTeamById(id: string): Team | undefined {
    return this.availableTeams.find(team => team.id === id);
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}