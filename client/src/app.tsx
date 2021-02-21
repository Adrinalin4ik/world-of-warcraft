import React from 'react';
import './app.scss';
import Auth from './pages/auth/auth';
import GameScreen from './pages/game';

import {
  BrowserRouter as Router,
  Switch,
  Route,
  Link
} from "react-router-dom";
import { GameSession } from './network/session';
import RealmsScreen from './pages/realms/realms';
import CharactersScreen from './pages/characters';
const gameSession = new GameSession();

const App: React.FC = () => {
  return (
    <Router>
      <div className="wowser">
        <nav>
          <ul>
            <li>
              <Link to="/auth">Auth</Link>
            </li>
          </ul>
        </nav>

        {/* A <Switch> looks through its children <Route>s and
            renders the first one that matches the current URL. */}
        <Switch>
          
          <Route path="/realms">
            <RealmsScreen session={gameSession}/>
          </Route>
          <Route path="/characters">
            <CharactersScreen session={gameSession} />
          </Route>
          <Route path="/create-character">
            <div>create character</div>
          </Route>
          <Route path="/game">
            <GameScreen session={gameSession} />
          </Route>
          <Route path="/">
            <Auth session={gameSession} />
          </Route>
        </Switch>
      </div>
    </Router>
  );
}

export default App;
