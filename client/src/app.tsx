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

const App: React.FC = () => {
  return (
    <Router>
      <div>
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
          <Route path="/auth">
            <Auth />
          </Route>
          <Route path="/realm">
            <div>realm select</div>
          </Route>
          <Route path="/characters-list">
            <div>character list</div>
          </Route>
          <Route path="/create-character">
            <div>create character</div>
          </Route>
          <Route path="/">
            <GameScreen />
          </Route>
        </Switch>
      </div>
    </Router>
  );
}

export default App;
