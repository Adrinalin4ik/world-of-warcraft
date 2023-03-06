import React from 'react';
import './app.scss';
import { GameSession } from './network/session';



const App: React.FC = () => {
  const gameSession = new GameSession();

  // // if (window.location.pathname != '/') {
  // //   window.location.replace('/' + window.location.search);
  // // }

  // const router = createBrowserRouter([
  //   {
  //     path: "/",
  //     element: <Auth session={gameSession} />
  //   },
  //   {
  //     path: "/realms",
  //     element:  <RealmsScreen session={gameSession}/>,
  //   },
  //   {
  //     path: "/characters",
  //     element: <CharactersScreen session={gameSession} />,
  //   },
  //   {
  //     path: "/create-character",
  //     element: <div>create character</div>
  //   },
  //   {
  //     path: "/game",
  //     element: <GameScreen session={gameSession} />
  //   },
  // ]);

  return (
    <div className="wowser">
      {/* <RouterProvider router={router} /> */}
    </div>
  );
}

export default App;
