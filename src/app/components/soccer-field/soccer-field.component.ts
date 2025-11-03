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
    // Striped grass background (alternating shades)
    const stripeCount = 12;
    const stripeWidth = this.fieldWidth / stripeCount;
    for (let i = 0; i < stripeCount; i++) {
      this.ctx.fillStyle = i % 2 === 0 ? '#237B22' : '#2A8F26';
      this.ctx.fillRect(i * stripeWidth, 0, stripeWidth, this.fieldHeight);
    }

    // Draw field lines
    this.drawFieldLines();

    // Draw players
    this.drawPlayers();

    // Draw ball
    this.drawBall();
  }

  private drawFieldLines(): void {
    this.ctx.strokeStyle = '#FFFFFF';
    this.ctx.lineWidth = 2.5;

    const gs = environment.gameSettings;
    const M = 10; // boundary margin
    const innerLengthPx = this.fieldWidth - 2 * M; // corresponds to 105m
    const innerWidthPx = this.fieldHeight - 2 * M;  // corresponds to 68m
    const pxPerMeterX = innerLengthPx / gs.pitchLengthM;
    const pxPerMeterY = innerWidthPx / gs.pitchWidthM;

    // Helper functions
    const xFromM = (m: number) => M + m * pxPerMeterX;
    const yFromM = (m: number) => M + m * pxPerMeterY;

    // Outer boundary
    this.ctx.strokeRect(M, M, innerLengthPx, innerWidthPx);

    // Halfway line
    this.ctx.beginPath();
    this.ctx.moveTo(M + innerLengthPx / 2, M);
    this.ctx.lineTo(M + innerLengthPx / 2, M + innerWidthPx);
    this.ctx.stroke();

    // Center circle & spot
    const centerCircleR = gs.centerCircleRadiusM * pxPerMeterY;
    const centerX = M + innerLengthPx / 2;
    const centerY = M + innerWidthPx / 2;
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, centerCircleR, 0, 2 * Math.PI);
    this.ctx.stroke();
    this.ctx.fillStyle = '#FFFFFF';
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, 3, 0, 2 * Math.PI);
    this.ctx.fill();

    // Penalty & goal areas (left side origin at 0m horizontally)
    const goalAreaDepthPx = gs.goalAreaDepthM * pxPerMeterX;
    const goalAreaWidthPx = 18.32 * pxPerMeterY; // standard width
    const penaltyAreaDepthPx = gs.penaltyAreaDepthM * pxPerMeterX;
    const penaltyAreaWidthPx = 40.32 * pxPerMeterY;

    const goalAreaY = centerY - goalAreaWidthPx / 2;
    const penaltyAreaY = centerY - penaltyAreaWidthPx / 2;

    // Left goal area
    this.ctx.strokeRect(M, goalAreaY, goalAreaDepthPx, goalAreaWidthPx);
    // Right goal area
    this.ctx.strokeRect(M + innerLengthPx - goalAreaDepthPx, goalAreaY, goalAreaDepthPx, goalAreaWidthPx);

    // Left penalty area
    this.ctx.strokeRect(M, penaltyAreaY, penaltyAreaDepthPx, penaltyAreaWidthPx);
    // Right penalty area
    this.ctx.strokeRect(M + innerLengthPx - penaltyAreaDepthPx, penaltyAreaY, penaltyAreaDepthPx, penaltyAreaWidthPx);

    // Penalty spots (11m)
    const penSpotXLeft = M + gs.penaltySpotDistM * pxPerMeterX;
    const penSpotXRight = M + innerLengthPx - gs.penaltySpotDistM * pxPerMeterX;
    this.ctx.beginPath(); this.ctx.arc(penSpotXLeft, centerY, 3, 0, 2 * Math.PI); this.ctx.fill();
    this.ctx.beginPath(); this.ctx.arc(penSpotXRight, centerY, 3, 0, 2 * Math.PI); this.ctx.fill();

    // Penalty arcs (9.15m radius) centered at penalty spot, trimmed outside area
    const arcR = gs.centerCircleRadiusM * pxPerMeterY;
    this.ctx.beginPath();
    this.ctx.arc(penSpotXLeft, centerY, arcR, -0.6, 0.6); // facing outwards
    this.ctx.stroke();
    this.ctx.beginPath();
    this.ctx.arc(penSpotXRight, centerY, arcR, Math.PI - 0.6, Math.PI + 0.6);
    this.ctx.stroke();

    // Goals (7.32m width, 2.44m height) simplified 2D front view outside boundary
    const goalWidthPx = gs.goalWidthM * pxPerMeterY;
    const goalHeightPx = 2.44 * pxPerMeterY;
    const goalTopY = centerY - goalWidthPx / 2;
    // Left goal posts just outside left boundary
    const goalDepth = 8; // pixels
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(M - goalDepth, goalTopY, goalDepth, goalWidthPx);
    // Right goal
    this.ctx.strokeRect(M + innerLengthPx, goalTopY, goalDepth, goalWidthPx);
    this.ctx.lineWidth = 2.5;

    // Corner arcs (radius 1m)
    const cornerR = 1 * pxPerMeterX;
    const corners: [number, number, number, number][] = [
      [M, M, 0, Math.PI / 2],
      [M + innerLengthPx, M, Math.PI / 2, Math.PI],
      [M, M + innerWidthPx, -Math.PI / 2, 0],
      [M + innerLengthPx, M + innerWidthPx, Math.PI, 3 * Math.PI / 2]
    ];
    corners.forEach(([cx, cy, a1, a2]) => {
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, cornerR, a1, a2);
      this.ctx.stroke();
    });

    // Restore thicker lines for rest of drawing cycle
    this.ctx.lineWidth = 3;
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