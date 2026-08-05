/**
 * The wiring, and the promise that comes with it: adding the protocol layer must not disturb the
 * screens still using the old handlers, and must not open a socket by existing.
 */
import { GameSession } from '../session';
import { ProtocolSession } from '../protocol/session';

jest.mock('../../game/world', () => ({
  __esModule: true,
  default: class FakeWorld {
    player = { worldport: jest.fn() };
    scene = { add: jest.fn() };
  },
}));

describe('GameSession protocol wiring', () => {
  it('exposes a ProtocolSession', () => {
    expect(new GameSession().protocol).toBeInstanceOf(ProtocolSession);
  });

  it('opens no socket by being constructed', () => {
    const spy = jest.spyOn(window, 'WebSocket' as never);
    const session = new GameSession();

    void session.protocol;

    expect(spy).not.toHaveBeenCalled();
    expect((session.auth as any).socket).toBeNull();
    expect((session.game as any).socket).toBeNull();
    spy.mockRestore();
  });

  it('keeps the legacy handlers the old screens still use', () => {
    const session = new GameSession();

    // Spec 3 removes these; until then they must keep existing.
    expect(typeof (session.auth as any).authenticate).toBe('function');
    expect(typeof (session.realms as any).refresh).toBe('function');
    expect(typeof (session.characters as any).refresh).toBe('function');
    expect(session.protocol.stage).toBe('Offline');
  });
});
