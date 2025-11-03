import { Component } from '@angular/core';
import { GameSimulatorComponent } from './components/game-simulator/game-simulator.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [GameSimulatorComponent],
  template: `
    <div class="container">
      <h1>⚽ Soccer Game Simulator ⚽</h1>
      <div class="game-container">
        <app-game-simulator></app-game-simulator>
      </div>
    </div>
  `
})
export class AppComponent {
  title = 'Soccer Game Simulator';
}