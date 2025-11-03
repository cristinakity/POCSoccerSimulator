import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

import { AppComponent } from './app.component';
import { GameSimulatorComponent } from './components/game-simulator/game-simulator.component';
import { SoccerFieldComponent } from './components/soccer-field/soccer-field.component';
import { GameLogComponent } from './components/game-log/game-log.component';

@NgModule({
  declarations: [
    AppComponent,
    GameSimulatorComponent,
    SoccerFieldComponent,
    GameLogComponent
  ],
  imports: [
    BrowserModule,
    FormsModule
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule { }