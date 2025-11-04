export const environment = {
  production: false,
  gameSettings: {
    // With 45s duration we map 1 simulation second to 1 real match minute (single half)
    defaultGameDuration: 45, // seconds (represents 45 real minutes)
    fieldWidth: 900,
    fieldHeight: 600,
    pitchLengthM: 105, // meters (touchline length)
    pitchWidthM: 68,   // meters (goal to goal width)
    goalWidthM: 7.32,
    goalAreaDepthM: 5.5,
  // penaltyAreaDepthM already declared above; remove duplicate entry
    penaltySpotDistM: 11,
    centerCircleRadiusM: 9.15,
    speed: {
      playerBase: 5.5,       // faster player movement (was 4.0)
      chaseExtra: 2.8,       // aggressive ball pursuit (was 2.0)
      passSpeed: 32,         // faster passes (was 24)
      shotSpeed: 38,         // powerful shots (was 30)
      maxBallSpeed: 45,      // higher max speed (was 36)
      frictionPossessed: 0.991, // smooth dribbling (was 0.993)
      frictionFree: 0.984    // ball slows naturally (was 0.986)
    },
    playerSize: 12,
    ballSize: 8,
    experimentalBounce: false, // when true, ball will bounce off boundaries instead of triggering throw-ins (non-official soccer)
    decisionIntervalMs: 60, // AI decision cadence (ms) - faster decisions (was 85)
    randomSeed: null as number | null, // set to a number for deterministic simulation
    ballDecayFree: 0.985, // decay applied each frame when ball free (overrides frictionFree if set)
    ballDecayPossessed: 0.994, // decay when dribbling (matches frictionPossessed by default)
    weather: 'clear' as 'clear' | 'rain' | 'heat', // affects stamina & friction
    crowdIntensity: 0.5, // 0-1 influences momentum commentary
    penaltyAreaDepthM: 16.5,
    xgTuning: { distanceScale: 250, angleScale: 1, pressureScale: 160 },
    passUtilityWeights: { progress: 0.55, support: 0.25, risk: 0.20 }
  }
};