import React from 'react';

import { GlueHost } from './glue';
import { GameScreen } from './game';
import type { GameSession } from '../network/session';

/**
 * `/` -- THE GLUE SCREENS AND THE WORLD ON ONE ROUTE, swapped in place instead of navigated between.
 *
 * The owner asked for this by name: "не нужно после логина редиректить на /game, нужно маунтить игру
 * на /". Entering the world used to `navigate('/game')` and leaving it used to `navigate('/')`, and both
 * of those change the URL for no reason the player can see.
 *
 * ## WHY THE URL MATTERS HERE MORE THAN IT USUALLY DOES
 *
 * Every switch this client has is a query parameter, and several are read PER CONNECT rather than once:
 * `?ui=lua` picks the FrameXML screens over the hand-written transcription, `?realmlist=` and `?gateway=`
 * name the host every socket dials (`network/gateway.ts#currentSettings`), and `?login=&password=&...`
 * drives the autologin walk (`ui/screens/auto-login.ts`). So the URL is the session's configuration, and
 * a navigation that drops or changes it reconfigures the client silently.
 *
 * Both old callbacks knew that and carried `window.location.search` along by hand, each with a paragraph
 * explaining what had already broken once without it -- a world disconnect that came back to the
 * TRANSCRIBED login screen because the search string was lost, measured and photographed. **Not
 * navigating removes that whole class of bug by construction**: there is no place left for the query
 * string to be dropped, because nothing rewrites the location at all.
 *
 * And it is what the owner actually hit: a refresh after entering the world reloaded `/game`, which
 * without `?ui=lua` is a different client -- "обновление страницы после входа ведёт меня в нашу
 * песочницу". Now a refresh replays exactly what the URL says, which for an autologin URL means walking
 * straight back into the world.
 *
 * ## WHAT THIS IS NOT
 *
 * It is not a change to either host. `GlueHost` still runs `GlueApp#stop()` in its
 * `componentWillUnmount` and `GameScreen` still owns its own frame loop; React unmounts one and mounts
 * the other exactly as the router did. The `GameSession` is created once in `App` and handed to both, so
 * the world survives the swap -- which is the same reason both directions were router navigations rather
 * than document ones.
 *
 * `/game` and `/glue` stay in the route table. They are direct entry points -- `/game?offline=1` is this
 * project's documented way into a world with no server -- and nothing that bookmarks them should break
 * because the default flow stopped using them.
 */
const RootRoute: React.FC<{ session: GameSession }> = ({ session }) => {
  /**
   * Which half is mounted. Starts on the glue screens, which is what a fresh load of `/` shows.
   *
   * State and not a route, so the URL is never touched. `GameSession` outlives the flag either way.
   */
  const [inWorld, setInWorld] = React.useState(false);

  const enterWorld = React.useCallback(() => {
    console.info('root: entering the world; swapping the glue host for the game screen');
    setInWorld(true);
  }, []);

  const disconnected = React.useCallback(() => {
    console.info('root: left the world; swapping back to the glue host');
    setInWorld(false);
  }, []);

  return inWorld
    ? <GameScreen session={session} onDisconnected={disconnected} />
    : <GlueHost session={session} onEnterWorld={enterWorld} />;
};

export default RootRoute;
