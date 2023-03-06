import React from 'react';
import {
  BrowserRouter as Router, Link, Route, Switch
} from "react-router-dom";
import './app.scss';
import { GameSession } from './network/session';
import Auth from './pages/auth/auth';
import CharactersScreen from './pages/characters';
import GameScreen from './pages/game';
import RealmsScreen from './pages/realms/realms';

const gameSession = new GameSession();

// if (window.location.pathname != '/') {
//   window.location.replace('/' + window.location.search);
// }

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
