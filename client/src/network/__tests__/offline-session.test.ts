/**
 * The offline debug route. The point of these tests is the NEGATIVE: no socket may be opened, so
 * world/render debugging never depends on a server being up.
 */
import { isOfflineRequested, OFFLINE_SPOT_ID, sessionForSearch } from '../offline-session';

jest.mock('../../game/world', () => {
  return {
    __esModule: true,
    default: class FakeWorld {
      player = { worldport: jest.fn() };
      scene = { add: jest.fn() };
    },
  };
});

describe('isOfflineRequested', () => {
  it('accepts the flag with and without a value', () => {
    expect(isOfflineRequested('?offline=1')).toBe(true);
    expect(isOfflineRequested('?offline')).toBe(true);
    expect(isOfflineRequested('?account=x&offline=1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isOfflineRequested('')).toBe(false);
    expect(isOfflineRequested('?account=x')).toBe(false);
    expect(isOfflineRequested('?offline=0')).toBe(false);
  });
});

describe('sessionForSearch', () => {
  it('opens no socket in offline mode', () => {
    const session = sessionForSearch('?offline=1');

    expect((session.game as any).connected).toBeFalsy();
    expect((session.auth as any).connected).toBeFalsy();
    expect((session as any).offline).toBe(true);
  });

  it('seeds a stub character at a known spot', () => {
    const session = sessionForSearch('?offline=1');

    expect((session as any).offlineSpot).toBe(OFFLINE_SPOT_ID);
    expect(session.player).toBeTruthy();
  });

  it('returns a plain session without the flag', () => {
    expect((sessionForSearch('') as any).offline).toBeFalsy();
  });
});
