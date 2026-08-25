import React from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './app.scss';
import { sessionForSearch } from './network/offline-session';
import GameRoute from './pages/game';
import GlueHost from './pages/glue';
import RootRoute from './pages/root';


const App: React.FC = () => {
  // `?offline=1` builds a session that never connects -- the debug path into the world.
  const gameSession = sessionForSearch(window.location.search);

  // A commented-out `location.replace` used to sit here, forcing every path back to `/`. It is gone
  // rather than left dormant: the root route now holds both halves of the client, so nothing needs
  // to rewrite the location -- see `pages/root.tsx`.

  const router = createBrowserRouter([
    {
      /**
       * THE GLUE SCREENS **AND** THE WORLD, on one route and swapped in place.
       *
       * Entering the world used to navigate to `/game` and leaving it used to navigate back here,
       * which changed the URL for no reason a player can see -- and this URL is the session's
       * configuration (`?ui=lua`, `?realmlist=`, `?gateway=`, the autologin four). A refresh after
       * entering therefore reloaded `/game`, which without `?ui=lua` is a different client: the
       * owner's "обновление страницы после входа ведёт меня в нашу песочницу".
       *
       * See `pages/root.tsx` for what the swap does and does not change.
       */
      path: "/",
      element: <RootRoute session={gameSession} />
    },
    {
      path: "/game",
      element: <GameRoute session={gameSession} />
    },
    {
      // Kept as DIRECT ENTRY POINTS, not as the default flow any more. `/game?offline=1` is this
      // project's documented way into a world with no server, and `/glue` is the glue screens on
      // their own; both still navigate between each other the way they always did.
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
