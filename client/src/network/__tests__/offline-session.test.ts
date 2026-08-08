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
  let webSocketSpy: jest.SpyInstance;

  beforeEach(() => {
    // The invariant this whole task exists to prove: nothing offline ever constructs a
    // WebSocket. `Socket#connected` (`getter: this.socket && this.socket.readyState ===
    // WebSocket.OPEN`) is useless as a witness for this -- a freshly-opened WebSocket sits in
    // CONNECTING, never OPEN, so `.connected` reads falsy whether or not `connect()` ran. `.socket`
    // itself (null until `connect()` assigns it) and a spy on the global constructor are the two
    // things that actually catch a stray connect.
    webSocketSpy = jest.spyOn(window, 'WebSocket' as any);
  });

  afterEach(() => {
    webSocketSpy.mockRestore();
  });

  it('opens no socket in offline mode', () => {
    const session = sessionForSearch('?offline=1');

    expect((session.game as any).socket).toBeNull();
    expect((session.auth as any).socket).toBeNull();
    expect(session.offline).toBe(true);
    expect(webSocketSpy).not.toHaveBeenCalled();
  });

  it('announces the offline run exactly once, and never for a plain session', () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    sessionForSearch('?offline=1');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toContain('[offline]');

    infoSpy.mockClear();
    sessionForSearch('');
    expect(infoSpy).not.toHaveBeenCalled();

    infoSpy.mockRestore();
  });

  it('records the offline spawn spot, distinctly from a plain session', () => {
    const session = sessionForSearch('?offline=1');
    const plain = sessionForSearch('');

    expect(session.offlineSpot).toBe(OFFLINE_SPOT_ID);
    expect(plain.offlineSpot).toBeUndefined();
    expect(plain.offline).toBeFalsy();
  });

  it('returns a plain session without the flag', () => {
    expect(sessionForSearch('').offline).toBeFalsy();
  });
});
