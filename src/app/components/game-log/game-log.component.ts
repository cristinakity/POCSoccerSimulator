import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { GameEvent } from '../../services/team.service';

@Component({
  selector: 'app-game-log',
  template: `
    <div class="game-log">
      <h4>Game Events</h4>
      <div class="log-container" #logContainer>
        <div 
          *ngFor="let event of events; let i = index; trackBy: trackByIndex" 
          [class]="'log-entry ' + event.type"
        >
          <strong>{{formatTime(event.time)}}</strong> - {{event.description}}
        </div>
        <div *ngIf="events.length === 0" class="no-events">
          No events yet. Start the game to see the action!
        </div>
      </div>
    </div>
  `,
  styles: [`
    .log-container {
      max-height: 350px;
      overflow-y: auto;
      padding-right: 5px;
    }

    .log-container::-webkit-scrollbar {
      width: 6px;
    }

    .log-container::-webkit-scrollbar-track {
      background: #f1f1f1;
      border-radius: 10px;
    }

    .log-container::-webkit-scrollbar-thumb {
      background: #888;
      border-radius: 10px;
    }

    .log-container::-webkit-scrollbar-thumb:hover {
      background: #555;
    }

    .no-events {
      text-align: center;
      color: #666;
      font-style: italic;
      padding: 20px;
    }

    .log-entry {
      margin-bottom: 8px;
      transition: all 0.3s ease;
    }

    .log-entry:hover {
      transform: translateX(5px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
  `]
})
export class GameLogComponent implements OnInit, OnDestroy {
  @Input() events: GameEvent[] = [];
  
  private lastEventCount = 0;

  ngOnInit(): void {
    // Component initialization
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }

  ngOnChanges(): void {
    // Auto-scroll to bottom when new events are added
    if (this.events.length > this.lastEventCount) {
      this.lastEventCount = this.events.length;
      setTimeout(() => this.scrollToBottom(), 100);
    }
  }

  trackByIndex(index: number, item: GameEvent): number {
    return index;
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  private scrollToBottom(): void {
    try {
      const logContainer = document.querySelector('.log-container');
      if (logContainer) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    } catch (err) {
      console.log('Could not scroll to bottom:', err);
    }
  }
}