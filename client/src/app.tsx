import React from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './app.scss';
import { GameSession } from './network/session';
import Auth from './pages/auth/auth';
import CharactersScreen from './pages/characters';
import GameScreen from './pages/game';
import RealmsScreen from './pages/realms/realms';


const App: React.FC = () => {
  const gameSession = new GameSession();

  // // if (window.location.pathname != '/') {
  // //   window.location.replace('/' + window.location.search);
  // // }

  const router = createBrowserRouter([
    {
      path: "/",
      element: <Auth session={gameSession} />
    },
    {
      path: "/realms",
      element:  <RealmsScreen session={gameSession}/>,
    },
    {
      path: "/characters",
      element: <CharactersScreen session={gameSession} />,
    },
    {
      path: "/create-character",
      element: <div>create character</div>
    },
    {
      path: "/game",
      element: <GameScreen session={gameSession} />
    },
  ]);

  return (
    <div className="wowser">
      <RouterProvider router={router} />
    </div>
  );
}

export default App;
