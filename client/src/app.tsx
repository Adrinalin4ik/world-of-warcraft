import React from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './app.scss';
import { sessionForSearch } from './network/offline-session';
import Auth from './pages/auth/auth';
import CharactersScreen from './pages/characters';
import GameScreen from './pages/game';
import GlueHost from './pages/glue';
import RealmsScreen from './pages/realms/realms';


const App: React.FC = () => {
  // `?offline=1` builds a session that never connects -- the debug path into the world.
  const gameSession = sessionForSearch(window.location.search);

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
    {
      // The glue app -- the in-canvas pre-world screens. Spec 3 moves this onto "/" when the
      // transcribed AccountLogin replaces the probe screen.
      path: "/glue",
      element: <GlueHost session={gameSession} />
    },
  ], {
    // Serve the same route table from a sub-path when the app is not at the domain root.
    //
    // On a GitHub Pages PROJECT site the app lives under `/<repo>/`, so the browser's URL for the
    // game screen is `/world-of-warcraft/game`, not `/game`. Without a basename every route above
    // fails to match and the app renders nothing but a blank page -- which looks like a build
    // failure rather than a routing one.
    //
    // `PUBLIC_URL` is inlined at build time by the CRA build (`config/paths.js` derives it from the
    // env var or package.json's `homepage`). It is empty for a normal local build and for `yarn
    // start`, and react-router rejects an empty basename, hence the `/` fallback.
    basename: process.env.PUBLIC_URL || '/',
  });

  return (
    <div className="wowser">
      <RouterProvider router={router} />
    </div>
  );
}

export default App;
