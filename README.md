# Soccer Game Simulator ⚽

A fun and modern Angular web application that simulates soccer games with HTML5 Canvas graphics. Watch as teams with funny names compete in an entertaining 30-second match!

## Features

- 🎮 **Interactive Game Simulation**: Choose from randomly generated teams with funny names
- ⚽ **Real-time Soccer Field**: HTML5 Canvas-based top-view soccer field with animated players and ball
- 🎯 **Dynamic Gameplay**: Players move towards the ball, realistic ball physics with bouncing
- 📊 **Live Score Tracking**: Real-time score updates and game timer
- 📝 **Game Event Log**: Live commentary of goals, fouls, corners, and other events
- 🎨 **Modern UI**: Beautiful gradient backgrounds and smooth animations
- ⚙️ **Configurable Duration**: Set game length from 10 to 300 seconds
- 🏆 **Team Customization**: Funny team names like "Lightning Llamas" and "Crazy Coconuts"

## Game Elements

### Teams
- **Funny Team Names**: Lightning Llamas, Crazy Coconuts, Flying Flamingos, Dancing Dragons, and more!
- **Player Names**: Speedy Gonzalez, Captain Crunch, Sir Kicks-a-Lot, Goal Digger, and others
- **Color-coded Teams**: Each team has a unique color for easy identification
- **Player Roles**: Goalkeepers, defenders, midfielders, and forwards

### Gameplay
- **Duration**: Configurable from 10 to 300 seconds (default: 30 seconds)
- **Physics**: Realistic ball movement with velocity, bouncing, and friction
- **AI Movement**: Players intelligently move towards the ball
- **Events**: Goals, fouls, corner kicks, offsides, and yellow cards
- **Visual Elements**: 
  - Soccer field with proper markings (center circle, penalty areas, goals)
  - Players represented as colored squares with numbers
  - Ball as a white circle with soccer ball pattern
  - Goalkeepers have special gold borders

## Getting Started

### Prerequisites
- Node.js (version 16 or higher)
- npm (Node Package Manager)

### Installation

1. **Navigate to the project directory:**
   \`\`\`bash
   cd POCSoccerSimulator
   \`\`\`

2. **Install dependencies:**
   \`\`\`bash
   npm install
   \`\`\`

3. **Start the development server:**
   \`\`\`bash
   npm start
   \`\`\`
   or
   \`\`\`bash
   ng serve
   \`\`\`

4. **Open your browser and navigate to:**
   \`\`\`
   http://localhost:4200
   \`\`\`

### Building for Production

To build the project for production:

\`\`\`bash
npm run build
\`\`\`

The build artifacts will be stored in the \`dist/\` directory.

## How to Play

1. **Select Teams**: Choose two different teams from the dropdown menus
2. **Set Duration**: Configure the game duration (10-300 seconds)
3. **Start Simulation**: Click "Start Simulation" to begin the match
4. **Watch the Action**: Observe players moving on the field and the ball physics
5. **Follow Events**: Check the game log for live commentary
6. **View Results**: See the final score when the timer reaches zero

## Project Structure

\`\`\`
POCSoccerSimulator/
├── src/
│   ├── app/
│   │   ├── components/
│   │   │   ├── game-simulator/     # Main game control component
│   │   │   ├── soccer-field/       # HTML5 Canvas field component
│   │   │   └── game-log/           # Event logging component
│   │   ├── services/
│   │   │   ├── team.service.ts     # Team and player generation
│   │   │   └── game-engine.service.ts  # Game logic and physics
│   │   ├── app.component.ts        # Root component
│   │   └── app.module.ts           # App module
│   ├── environments/               # Environment configurations
│   ├── assets/                     # Static assets
│   ├── styles.scss                 # Global styles
│   └── index.html                  # Main HTML file
├── angular.json                    # Angular CLI configuration
├── package.json                    # Project dependencies
└── README.md                       # This file
\`\`\`

## Technologies Used

- **Angular 17**: Modern web framework
- **TypeScript**: Type-safe JavaScript
- **HTML5 Canvas**: 2D graphics and animations
- **SCSS**: Advanced CSS with variables and mixins
- **RxJS**: Reactive programming for real-time updates
- **Google Fonts**: Orbitron and Exo 2 fonts for modern typography

## Game Mechanics

### Ball Physics
- **Velocity**: Ball has x and y velocity components
- **Bouncing**: Ball bounces off field boundaries with energy loss
- **Friction**: Ball gradually slows down over time
- **Randomness**: Small random forces keep the game unpredictable

### Player AI
- **Movement**: Players move towards the ball with some randomness
- **Positioning**: Different roles (goalkeeper, defender, etc.) start in appropriate positions
- **Collision Avoidance**: Players don't crowd too close to the ball

### Event Generation
- **Random Events**: Goals, fouls, corners, etc. occur randomly during the game
- **Weighted Probability**: Goals are less frequent but more exciting
- **Contextual Descriptions**: Events have entertaining commentary

## Customization

You can easily customize the game by modifying:

- **Team Names**: Add more funny team names in \`team.service.ts\`
- **Player Names**: Expand the player name list
- **Game Duration**: Adjust default duration in environment files
- **Field Size**: Modify canvas dimensions
- **Colors**: Change team colors and UI theme
- **Event Probability**: Adjust event generation rates

## Browser Compatibility

This application works on all modern browsers that support:
- HTML5 Canvas
- ES2022 JavaScript features
- CSS Grid and Flexbox
- Modern Angular features

## Contributing

Feel free to contribute by:
- Adding more team and player names
- Improving game physics
- Enhancing visual effects
- Adding new event types
- Improving responsive design

## License

This project is for educational and entertainment purposes.

---

**Enjoy the game! ⚽🎉**