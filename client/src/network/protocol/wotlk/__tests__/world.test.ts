import { EventEmitter } from 'events';
import { WotlkWorldTransport, createGameHandlerIo } from '../world';
import { ProtocolRefusalError } from '../../types';
import { CHAR_RESULT } from '../world-wire';

/** A packet-IO stand-in: records sends, lets the test deliver bodies by opcode name. */
function fakeIo() {
  const listeners = new Map<string, Array<(body: Uint8Array) => void>>();
  const disconnectListeners: Array<(reason: string) => void> = [];
  const sent: Array<{ opcode: number; body: Uint8Array }> = [];

  return {
    sent,
    closed: false,
    connect: jest.fn(async () => undefined),
    send(opcode: number, body: Uint8Array) {
      sent.push({ opcode, body });
    },
    on(opcodeName: string, listener: (body: Uint8Array) => void) {
      const existing = listeners.get(opcodeName) ?? [];
      existing.push(listener);
      listeners.set(opcodeName, existing);
    },
    onDisconnect(listener: (reason: string) => void) {
      disconnectListeners.push(listener);
    },
    close() {
      this.closed = true;
    },
    deliver(opcodeName: string, body: Uint8Array) {
      for (const listener of listeners.get(opcodeName) ?? []) {
        listener(body);
      }
    },
    triggerDisconnect(reason: string) {
      for (const listener of disconnectListeners) {
        listener(reason);
      }
    },
  };
}

const REALM = {
  id: 1,
  name: 'Test',
  host: 'realm.example.com',
  port: 8085,
  population: 1,
  characterCount: 0,
  online: true,
  recommended: false,
  pvp: false,
};

describe('WotlkWorldTransport', () => {
  it('resolves the roster from an enum body', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.characters();
    io.deliver('SMSG_CHAR_ENUM', new Uint8Array([0])); // zero characters

    await expect(pending).resolves.toEqual([]);
  });

  it('resolves a create on the success byte', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.createCharacter({
      name: 'Newbie',
      race: 1,
      class: 1,
      gender: 0,
      appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
      outfitId: 0,
    });
    io.deliver('SMSG_CHAR_CREATE', new Uint8Array([CHAR_RESULT.CREATE_SUCCESS]));

    await expect(pending).resolves.toBeUndefined();
    expect(io.sent).toHaveLength(1);
  });

  it('rejects a create with the client’s own key on refusal', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.createCharacter({
      name: 'Taken',
      race: 1,
      class: 1,
      gender: 0,
      appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
      outfitId: 0,
    });
    io.deliver('SMSG_CHAR_CREATE', new Uint8Array([0x31]));

    await expect(pending).rejects.toMatchObject({
      refusal: { stringKey: 'CHAR_CREATE_NAME_IN_USE' },
    });
  });

  it('resolves a delete on its own success byte', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.deleteCharacter('0x1');
    io.deliver('SMSG_CHAR_DELETE', new Uint8Array([CHAR_RESULT.DELETE_SUCCESS]));

    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves entering the world when the world verifies it', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.enterWorld('0x1');
    io.deliver('SMSG_LOGIN_VERIFY_WORLD', new Uint8Array(20));

    await expect(pending).resolves.toBeUndefined();
  });

  it('dials the realm at its own advertised address, not at a proxy host', async () => {
    // The gateway is handed the target in the URL and dials it itself (`network/gateway.ts`), so the
    // address the realm list advertises is exactly what should be asked for. The old scheme -- one
    // websockify per port, listening on the served host -- forced the realm's host to be replaced
    // with the proxy's, which made every realm the client could not guess a listener for unreachable.
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    void transport.join(REALM, 'TESTER', new Uint8Array(40));

    expect(io.connect).toHaveBeenCalledWith(
      REALM.host,
      REALM.port,
      REALM,
      'TESTER',
      expect.anything(),
    );
  });

  it('rejects a join when the handshake is refused', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.join(REALM, 'TESTER', new Uint8Array(40));
    io.deliver('SMSG_AUTH_RESPONSE', new Uint8Array([0x15]));

    await expect(pending).rejects.toBeInstanceOf(ProtocolRefusalError);
  });

  // --- Round 1 hardening: close()/disconnect abandon nothing, re-entrant calls don't orphan. ---

  it('rejects an in-flight characters() call rather than hanging when the transport is closed', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.characters();
    transport.close();

    await expect(pending).rejects.toThrow();
  });

  it('rejects an in-flight characters() call rather than hanging on a disconnect', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const pending = transport.characters();
    io.triggerDisconnect('socket closed');

    await expect(pending).rejects.toThrow();
  });

  it('rejects every in-flight request kind on close, not just one', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const joinPending = transport.join(REALM, 'TESTER', new Uint8Array(40));
    const rosterPending = transport.characters();
    const enterPending = transport.enterWorld('0x1');

    transport.close();

    await expect(joinPending).rejects.toThrow();
    await expect(rosterPending).rejects.toThrow();
    await expect(enterPending).rejects.toThrow();
  });

  it('rejects a second characters() call made while one is in flight, and still settles the first', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io);

    const first = transport.characters();
    const second = transport.characters();

    await expect(second).rejects.toThrow(/characters/);

    io.deliver('SMSG_CHAR_ENUM', new Uint8Array([0]));
    await expect(first).resolves.toEqual([]);
  });

  it('settles a refused join exactly once with the typed refusal, regardless of listener order', async () => {
    const io = fakeIo();
    // Registered on the same event BEFORE the transport's own listener, standing in for the
    // real handler's own internal auth-response handling -- the transport must settle correctly
    // no matter what else is subscribed first.
    let earlierListenerCalls = 0;
    io.on('SMSG_AUTH_RESPONSE', () => {
      earlierListenerCalls += 1;
    });

    const transport = new WotlkWorldTransport(io);
    const pending = transport.join(REALM, 'TESTER', new Uint8Array(40));
    io.deliver('SMSG_AUTH_RESPONSE', new Uint8Array([0x15]));

    await expect(pending).rejects.toBeInstanceOf(ProtocolRefusalError);
    expect(earlierListenerCalls).toBe(1);
  });
});

describe('createGameHandlerIo', () => {
  /**
   * `session.auth` mirrors the real `AuthHandler` shape closely enough to prove the fix: `key` is
   * a GETTER reading `srp && srp.K`, exactly like the real class, so a test reading `.key` (rather
   * than reaching into `.srp.K` directly) is actually going through the same mechanism the real
   * `handleAuthChallenge` does.
   */
  function fakeHandler() {
    const emitter = new EventEmitter();
    const auth = {
      account: null as string | null,
      srp: null as { K: number[] } | null,
      get key() {
        return this.srp && this.srp.K;
      },
    };
    return Object.assign(emitter, {
      connect: jest.fn(),
      send: jest.fn(),
      disconnect: jest.fn(),
      session: { auth },
    });
  }

  it('resolves connect() when the socket itself connects, not on the handshake verdict', async () => {
    const handler = fakeHandler();
    const io = createGameHandlerIo(handler as any);

    const pending = io.connect('localhost', 8085, REALM, 'tester', new Uint8Array(20));
    // No 'authenticate' event at all -- resolution must not depend on it.
    handler.emit('connect');

    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects connect(), naming the endpoint, if the socket closes before connecting', async () => {
    const handler = fakeHandler();
    const io = createGameHandlerIo(handler as any);

    const pending = io.connect('localhost', 8085, REALM, 'tester', new Uint8Array(20));
    handler.emit('disconnect');

    await expect(pending).rejects.toThrow(/localhost:8085/);
  });

  it('sets the account and session key on handler.session.auth before connect() is called', async () => {
    const handler = fakeHandler();
    const io = createGameHandlerIo(handler as any);

    let seenBeforeConnect: { account: string | null; key: number[] | null } | undefined;
    handler.connect.mockImplementation(() => {
      // Captured from inside the `connect` call itself: proves the assignment happened BEFORE
      // the handler was told to connect, not merely before this test's assertions ran.
      seenBeforeConnect = {
        account: handler.session.auth.account,
        key: handler.session.auth.key,
      };
    });

    const pending = io.connect('localhost', 8085, REALM, 'tester', new Uint8Array([1, 2, 3]));
    handler.emit('connect');
    await pending;

    // Upper-cased, and read through the same `key` getter `handleAuthChallenge` reads -- not by
    // reaching into `.srp.K` directly, so this also proves the key arrives in the shape (a plain
    // number[] behind the getter) the handler actually consumes.
    expect(seenBeforeConnect).toEqual({ account: 'TESTER', key: [1, 2, 3] });
  });
});
