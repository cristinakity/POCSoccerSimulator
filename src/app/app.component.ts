import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
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