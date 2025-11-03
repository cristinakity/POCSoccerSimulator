import { bootstrapApplication } from '@angular/platform-browser';
import { importProvidersFrom } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppComponent } from './app/app.component';

// Standalone bootstrap: AppComponent is now standalone and imports GameSimulatorComponent.
bootstrapApplication(AppComponent, {
  providers: [importProvidersFrom(FormsModule)]
}).catch(err => console.error(err));