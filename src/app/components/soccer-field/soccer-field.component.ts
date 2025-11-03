import { Component, Input, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { Team } from '../../services/team.service';
import { GameState } from '../../services/game-engine.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-soccer-field',
  template: `
    <canvas 
      #gameCanvas 
      id="gameCanvas" 
      [width]="fieldWidth" 
      [height]="fieldHeight">
      Your browser does not support the HTML5 Canvas element.
    </canvas>
  `
})
export class SoccerFieldComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('gameCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() team1: Team | undefined;
  @Input() team2: Team | undefined;
  @Input() gameState!: GameState;

  private ctx!: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;

  fieldWidth = environment.gameSettings.fieldWidth;
  fieldHeight = environment.gameSettings.fieldHeight;

  ngOnInit(): void {
    // Component initialization
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d')!;
    this.startAnimation();
  }

  ngOnDestroy(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  private startAnimation(): void {
    const animate = () => {
      this.drawField();
      this.animationFrameId = requestAnimationFrame(animate);
    };
    animate();
  }

  private drawField(): void {
    if (!this.ctx) return;

    // Clear canvas
    this.ctx.clearRect(0, 0, this.fieldWidth, this.fieldHeight);

    // Draw field background
    this.ctx.fillStyle = '#228B22'; // Forest green
    this.ctx.fillRect(0, 0, this.fieldWidth, this.fieldHeight);

    // Draw field lines
    this.drawFieldLines();

    // Draw players
    this.drawPlayers();

    // Draw ball
    this.drawBall();
  }

  private drawFieldLines(): void {
    this.ctx.strokeStyle = '#FFFFFF';
    this.ctx.lineWidth = 3;

    // Outer boundary
    this.ctx.strokeRect(10, 10, this.fieldWidth - 20, this.fieldHeight - 20);

    // Center line
    this.ctx.beginPath();
    this.ctx.moveTo(this.fieldWidth / 2, 10);
    this.ctx.lineTo(this.fieldWidth / 2, this.fieldHeight - 10);
    this.ctx.stroke();

    // Center circle
    this.ctx.beginPath();
    this.ctx.arc(this.fieldWidth / 2, this.fieldHeight / 2, 60, 0, 2 * Math.PI);
    this.ctx.stroke();

    // Goal areas
    const goalWidth = 120;
    const goalHeight = 40;
    const goalY = (this.fieldHeight - goalWidth) / 2;

    // Left goal area
    this.ctx.strokeRect(10, goalY, goalHeight, goalWidth);
    
    // Right goal area
    this.ctx.strokeRect(this.fieldWidth - 10 - goalHeight, goalY, goalHeight, goalWidth);

    // Penalty areas
    const penaltyWidth = 180;
    const penaltyHeight = 80;
    const penaltyY = (this.fieldHeight - penaltyWidth) / 2;

    // Left penalty area
    this.ctx.strokeRect(10, penaltyY, penaltyHeight, penaltyWidth);
    
    // Right penalty area
    this.ctx.strokeRect(this.fieldWidth - 10 - penaltyHeight, penaltyY, penaltyHeight, penaltyWidth);

    // Corner arcs
    const cornerRadius = 15;
    
    // Top-left corner
    this.ctx.beginPath();
    this.ctx.arc(10, 10, cornerRadius, 0, Math.PI / 2);
    this.ctx.stroke();

    // Top-right corner
    this.ctx.beginPath();
    this.ctx.arc(this.fieldWidth - 10, 10, cornerRadius, Math.PI / 2, Math.PI);
    this.ctx.stroke();

    // Bottom-left corner
    this.ctx.beginPath();
    this.ctx.arc(10, this.fieldHeight - 10, cornerRadius, -Math.PI / 2, 0);
    this.ctx.stroke();

    // Bottom-right corner
    this.ctx.beginPath();
    this.ctx.arc(this.fieldWidth - 10, this.fieldHeight - 10, cornerRadius, Math.PI, 3 * Math.PI / 2);
    this.ctx.stroke();
  }

  private drawPlayers(): void {
    const playerSize = environment.gameSettings.playerSize;

    // Draw team 1 players
    if (this.team1) {
      this.team1.players.forEach((player, index) => {
        this.ctx.fillStyle = this.team1!.color;
        this.ctx.strokeStyle = '#FFFFFF';
        this.ctx.lineWidth = 2;

        // Draw player as square
        const x = player.position.x - playerSize / 2;
        const y = player.position.y - playerSize / 2;
        
        this.ctx.fillRect(x, y, playerSize, playerSize);
        this.ctx.strokeRect(x, y, playerSize, playerSize);

        // Draw player number
        this.ctx.fillStyle = '#FFFFFF';
        this.ctx.font = '10px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText((index + 1).toString(), player.position.x, player.position.y + 3);

        // Draw goalkeeper differently
        if (player.role === 'goalkeeper') {
          this.ctx.strokeStyle = '#FFD700'; // Gold border for goalkeeper
          this.ctx.lineWidth = 3;
          this.ctx.strokeRect(x, y, playerSize, playerSize);
        }
      });
    }

    // Draw team 2 players
    if (this.team2) {
      this.team2.players.forEach((player, index) => {
        this.ctx.fillStyle = this.team2!.color;
        this.ctx.strokeStyle = '#FFFFFF';
        this.ctx.lineWidth = 2;

        // Draw player as square
        const x = player.position.x - playerSize / 2;
        const y = player.position.y - playerSize / 2;
        
        this.ctx.fillRect(x, y, playerSize, playerSize);
        this.ctx.strokeRect(x, y, playerSize, playerSize);

        // Draw player number
        this.ctx.fillStyle = '#FFFFFF';
        this.ctx.font = '10px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText((index + 1).toString(), player.position.x, player.position.y + 3);

        // Draw goalkeeper differently
        if (player.role === 'goalkeeper') {
          this.ctx.strokeStyle = '#FFD700'; // Gold border for goalkeeper
          this.ctx.lineWidth = 3;
          this.ctx.strokeRect(x, y, playerSize, playerSize);
        }
      });
    }
  }

  private drawBall(): void {
    const ballSize = environment.gameSettings.ballSize;
    const ball = this.gameState.ball;

    // Draw ball as circle
    this.ctx.fillStyle = '#FFFFFF';
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth = 2;

    this.ctx.beginPath();
    this.ctx.arc(ball.x, ball.y, ballSize / 2, 0, 2 * Math.PI);
    this.ctx.fill();
    this.ctx.stroke();

    // Add soccer ball pattern
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth = 1;
    
    // Draw pentagon pattern
    this.ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const angle = (i * 2 * Math.PI) / 5 - Math.PI / 2;
      const x = ball.x + Math.cos(angle) * (ballSize / 4);
      const y = ball.y + Math.sin(angle) * (ballSize / 4);
      
      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.closePath();
    this.ctx.stroke();
  }
}