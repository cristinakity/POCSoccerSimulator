import { Injectable } from '@angular/core';

export interface Team {
  id: string;
  name: string;
  color: string;
  players: Player[];
}

export interface Player {
  id: string;
  name: string;
  position: { x: number; y: number };
  role: 'goalkeeper' | 'defender' | 'midfielder' | 'forward';
  abilities?: PlayerAbilities; // optional until generated
  facing?: number; // radians, 0 points to the right
  mode?: 'idle' | 'dash' | 'turn' | 'kick';
  actionUntil?: number; // timestamp ms when current action ends
}

export interface PlayerAbilities {
  passPower: number;   // 0-100
  shotPower: number;   // 0-100
  accuracy: number;    // 0-100 (aim precision)
  stamina: number;     // 0-100 (current stamina)
  maxStamina: number;  // 60-100 (ceiling)
  speedFactor: number; // 0.8 - 1.2 multiplier over base speed
  agility: number;     // 0-100 – responsiveness & lateral quickness
}

export interface GameEvent {
  time: number;
  type: 'goal' | 'foul' | 'substitution' | 'corner' | 'offside' | 'yellow_card' | 'red_card' | 'pass' | 'shot' | 'coin_toss' | 'kickoff' | 'throw_in' | 'tackle' | 'interception' | 'clearance' | 'goal_kick' | 'save' | 'penalty';
  team: string;
  player: string;
  description: string;
  displayTime?: string; // scaled match clock (e.g., 12:34)
  realMinute?: number;  // corresponding real 45-min match minute (0-45)
  // Extended analytics fields
  startX?: number; // starting ball X coordinate (field units)
  startY?: number; // starting ball Y coordinate
  endX?: number;   // ending / intended target X
  endY?: number;   // ending / intended target Y
  result?: string; // outcome classification (complete, intercepted, goal, saved, blocked, attempt)
  role?: string;   // role of acting player at event time
  subtype?: string; // finer event subtype e.g. short_pass, long_pass, cross, through_ball
  zoneStart?: string; // zone label for start (defensive_third, middle_third, attacking_third, left_flank, right_flank, central)
  zoneEnd?: string;   // zone label for end
  xg?: number;        // expected goal value (0-1) for shot-related events
  pressure?: number;  // distance of nearest opponent at action time
  facingError?: number; // angular difference between player facing and action direction (radians)
}

@Injectable({
  providedIn: 'root'
})
export class TeamService {
  private funnyTeamNames = [
    'Lightning Llamas', 'Crazy Coconuts', 'Flying Flamingos', 'Dancing Dragons',
    'Bouncing Bananas', 'Mighty Marshmallows', 'Sneaky Squirrels', 'Giggling Giraffes',
    'Roaring Rubber Ducks', 'Blazing Butterflies', 'Thundering Tacos', 'Jumping Jellybeans',
    'Spinning Spiders', 'Magical Muffins', 'Warrior Waffles', 'Cosmic Cookies',
    'Fantastic Frogs', 'Ninja Noodles', 'Super Sloths', 'Incredible Ice Cream',
    'Wacky Wizards', 'Funky Foxes', 'Silly Sharks', 'Marvelous Monkeys'
  ];

  private funnyPlayerNames = [
    'Speedy Gonzalez', 'Captain Crunch', 'Sir Kicks-a-Lot', 'The Flash Gordon',
    'Messi McMessface', 'Goal Digger', 'Ronaldo Rascal', 'Pele Banana',
    'Beckham Boom', 'Zlatan Zap', 'Ninja Turtle', 'Super Mario',
    'Rocket Man', 'Thunder Bolt', 'Captain Awesome', 'The Magician',
    'Speed Demon', 'Goal Machine', 'The Professor', 'Wonder Kid',
    'Lightning Lee', 'Boom Boom', 'The Wizard', 'Mr. Fantastic',
    'Turbo Tom', 'Flash Fred', 'Mega Mike', 'Power Pete',
    'Sonic Sam', 'Blaze Billy', 'Storm Steve', 'Dash Dan'
  ];

  private teamColors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#FFB347', '#98D8C8', '#F7DC6F', '#AED6F1',
    '#F1948A', '#82E0AA', '#D7BDE2', '#F8C471', '#85C1E9',
    '#FF8A80', '#80CBC4', '#81C784', '#FFB74D', '#F48FB1'
  ];

  generateRandomTeams(): Team[] {
    const shuffledNames = [...this.funnyTeamNames].sort(() => Math.random() - 0.5);
    let shuffledColors = [...this.teamColors].sort(() => Math.random() - 0.5);
    // Ensure first two colors are highly contrasting for visual clarity between teams
    shuffledColors = this.ensureContrastingFirstTwo(shuffledColors);
    
    const teams: Team[] = [];
    
    for (let i = 0; i < Math.min(12, shuffledNames.length); i++) {
      teams.push({
        id: `team_${i}`,
        name: shuffledNames[i],
        color: shuffledColors[i],
        players: this.generatePlayers()
      });
    }
    
    return teams;
  }

  // --- Color contrast utilities to guarantee distinguishable team kits ---
  private ensureContrastingFirstTwo(colors: string[]): string[] {
    if (colors.length < 2) return colors;
    const [first, second] = colors;
    const ratio = this.contrastRatio(first, second);
    // Desired minimum contrast ratio (WCAG AA text is 4.5; here we pick 3 for broad color distinction)
    if (ratio >= 3) return colors;
    // Find alternative color with maximal contrast to first
    let bestColor = second;
    let bestRatio = ratio;
    for (let i = 2; i < colors.length; i++) {
      const c = colors[i];
      const r = this.contrastRatio(first, c);
      if (r > bestRatio) { bestRatio = r; bestColor = c; }
      if (r >= 4.5) { bestColor = c; break; } // good enough, early exit
    }
    // Swap chosen high-contrast color into second position
    const idx = colors.indexOf(bestColor);
    if (idx > 1) {
      const newColors = [...colors];
      [newColors[1], newColors[idx]] = [newColors[idx], newColors[1]];
      return newColors;
    }
    return colors;
  }

  private contrastRatio(a: string, b: string): number {
    const lumA = this.relativeLuminance(a);
    const lumB = this.relativeLuminance(b);
    const L1 = Math.max(lumA, lumB);
    const L2 = Math.min(lumA, lumB);
    return (L1 + 0.05) / (L2 + 0.05);
  }

  private relativeLuminance(hex: string): number {
    const rgb = this.hexToRgb(hex);
    const srgb = [rgb.r, rgb.g, rgb.b].map(v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean, 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255
    };
  }

  private generatePlayers(): Player[] {
    const shuffledPlayerNames = [...this.funnyPlayerNames].sort(() => Math.random() - 0.5);
    const roles: ('goalkeeper' | 'defender' | 'midfielder' | 'forward')[] = [
      'goalkeeper',
      'defender', 'defender', 'defender', 'defender',
      'midfielder', 'midfielder', 'midfielder',
      'forward', 'forward', 'forward'
    ];

    return roles.map((role, index) => {
      const baseSkill = () => Math.floor(50 + Math.random() * 50); // 50-100
      const powerVariance = role === 'forward' ? 10 : role === 'midfielder' ? 0 : -5;
      const speedVariance = role === 'forward' ? 0.1 : role === 'midfielder' ? 0.05 : role === 'defender' ? -0.05 : -0.1;
      const passPower = Math.min(100, Math.max(30, baseSkill() + (role === 'midfielder' ? 5 : 0)));
      const shotPower = Math.min(100, Math.max(35, baseSkill() + powerVariance));
      const accuracy = Math.min(100, Math.max(40, baseSkill() + (role === 'forward' ? 5 : 0)));
      const maxStamina = Math.floor(60 + Math.random() * 40); // 60-100
      const agility = Math.min(100, Math.max(40, baseSkill() + (role === 'midfielder' ? 5 : role === 'forward' ? 8 : 0)));
      const abilities: PlayerAbilities = {
        passPower,
        shotPower,
        accuracy,
        stamina: maxStamina,
        maxStamina,
        speedFactor: 1 + speedVariance + (Math.random() - 0.5) * 0.1,
        agility
      };
      return {
        id: `player_${index}`,
        name: shuffledPlayerNames[index] || `Player ${index + 1}`,
        position: { x: 0, y: 0 }, // Will be set during game initialization
        role,
        abilities
      } as Player;
    });
  }

  getRandomEventDescription(eventType: string, playerName: string, teamName: string): string {
    const events = {
      goal: [
        `GOAAAAL! ${playerName} scores for ${teamName}!`,
        `${playerName} finds the back of the net! What a shot!`,
        `Amazing goal by ${playerName}! The crowd goes wild!`,
        `${playerName} strikes! It's a goal for ${teamName}!`,
        `INCREDIBLE! ${playerName} scores a spectacular goal!`
      ],
      foul: [
        `${playerName} commits a foul. Free kick awarded!`,
        `Ouch! ${playerName} goes in too hard!`,
        `${playerName} gets a bit too aggressive there!`,
        `The referee blows the whistle - foul by ${playerName}!`,
        `Yellow card territory for ${playerName}!`
      ],
      corner: [
        `Corner kick for ${teamName}!`,
        `${playerName} wins a corner!`,
        `Great defending forces a corner kick!`,
        `${teamName} gets a dangerous corner opportunity!`
      ],
      goal_kick: [
        `Goal kick for ${teamName}.`,
        `${teamName} prepares a goal kick.`,
        `${playerName} places it for a goal kick.`,
        `Restart with a goal kick to ${teamName}.`
      ],
      offside: [
        `${playerName} is caught offside!`,
        `Offside! ${playerName} was too eager!`,
        `The linesman raises the flag - offside!`,
        `${playerName} needs to watch the line!`
      ],
      yellow_card: [
        `Yellow card for ${playerName}!`,
        `${playerName} gets booked!`,
        `The referee shows yellow to ${playerName}!`,
        `${playerName} needs to be more careful!`
      ],
      pass: [
        `${playerName} completes a tidy pass.`,
        `${playerName} finds a teammate in space.`,
        `Accurate distribution by ${playerName}.`,
        `${playerName} keeps possession moving.`
      ],
      shot: [
        `${playerName} takes a shot!`,
        `Powerful attempt by ${playerName}!`,
        `${playerName} tries one from distance.`,
        `${playerName} fires toward goal!`
      ],
      coin_toss: [
        `Coin toss underway...`,
        `The referee flips the coin.`,
        `Teams await the coin toss outcome.`
      ],
      kickoff: [
        `Kickoff! ${teamName} starts the match.`,
        `${teamName} gets us underway.`,
        `The ball rolls — match begins!`
      ]
      ,
      throw_in: [
        `Throw-in taken by ${playerName} for ${teamName}.`,
        `${teamName} puts the ball back in play (throw-in).`,
        `Quick throw by ${playerName}. Game resumes.`
      ],
      tackle: [
        `${playerName} wins the ball with a tackle!`,
        `Strong challenge from ${playerName}. Possession turned.`,
        `${playerName} slides in and takes it cleanly!`
      ]
      ,
      interception: [
        `${playerName} intercepts the pass!`,
        `Smart read by ${playerName} – interception!`,
        `${playerName} cuts out the passing lane.`
      ],
      penalty: [
        `Penalty awarded! ${playerName} to take it for ${teamName}.`,
        `Spot kick given – ${playerName} steps up!`,
        `Huge chance: penalty for ${teamName}! ${playerName} prepares.`
      ]
    };

    const eventList = events[eventType as keyof typeof events] || [`${playerName} is involved in the action!`];
    return eventList[Math.floor(Math.random() * eventList.length)];
  }
}