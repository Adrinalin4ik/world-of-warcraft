/**
 * The networking-free way into the world.
 *
 * `/game?offline=1` loads the world with a stub character and opens NO socket, so world and render
 * work does not wait on an auth server, a realm, or a character. Neither `AuthHandler` nor
 * `GameHandler` connects in its constructor -- only `connect()` does -- so "offline" is a matter of
 * never calling it, plus saying so out loud.
 *
 * The announcement is not decoration. The reference marks a no-IO run with a dedicated resource for
 * exactly this reason (benilla `net.rs#NetOffline`): a run that cannot exercise the wire must never
 * be mistaken for one that did.
 */
import spots from '../game/world/spots';
import { GameSession } from './session';

/** Where the offline character stands. A named spot, so the debug entry is reproducible. */
export const OFFLINE_SPOT_ID = 'stormwind';

export function isOfflineRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  if (!params.has('offline')) {
    return false;
  }
  const value = params.get('offline');
  return value === null || value === '' || value === '1' || value === 'true';
}

/** A session that will never connect, carrying a stub character and a spawn spot. */
export function createOfflineSession(): GameSession {
  const session = new GameSession() as GameSession & {
    offline: boolean;
    offlineSpot: string;
  };

  session.offline = true;
  session.offlineSpot = OFFLINE_SPOT_ID;

  console.info(
    `[offline] no auth, realm or world socket will be opened; standing at "${OFFLINE_SPOT_ID}"`,
  );

  return session;
}

export function sessionForSearch(search: string): GameSession {
  return isOfflineRequested(search) ? createOfflineSession() : new GameSession();
}

/** The spot record the game screen worldports to on offline entry. */
export function offlineSpot() {
  return spots.find((spot: any) => spot.id === OFFLINE_SPOT_ID) ?? spots[0];
}
