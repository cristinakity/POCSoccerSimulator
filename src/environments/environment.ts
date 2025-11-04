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
      playerBase: 5.0,       // faster general movement (was 3.2)
      chaseExtra: 2.5,       // more intense ball pursuit (was 1.6)
      passSpeed: 28,         // zippier passes (was 20)
      shotSpeed: 35,         // stronger shots (was 26)
      maxBallSpeed: 42,      // allow faster peak speed (was 32)
      frictionPossessed: 0.992, // keep dribbles lively (was 0.994)
      frictionFree: 0.985    // ball slows a bit faster for more control (was 0.988)
    },
    playerSize: 12,
    ballSize: 8,
    experimentalBounce: false, // when true, ball will bounce off boundaries instead of triggering throw-ins (non-official soccer)
    decisionIntervalMs: 70, // AI decision cadence (ms) - faster decisions (was 110)
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