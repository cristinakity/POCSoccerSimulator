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
    penaltyAreaDepthM: 16.5,
    penaltySpotDistM: 11,
    centerCircleRadiusM: 9.15,
    speed: {
      playerBase: 2.4,       // multiplier for player movement
      chaseExtra: 1.2,       // additional chase intensity
      passSpeed: 14,         // base pass speed
      shotSpeed: 18,         // base shot speed
      maxBallSpeed: 20,      // clamp for extreme shots
      frictionPossessed: 0.992,
      frictionFree: 0.985
    },
    playerSize: 12,
    ballSize: 8
  }
};