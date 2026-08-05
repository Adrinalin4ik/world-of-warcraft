/** @jest-environment node */
import { SrpLike, WotlkLogonTransport } from '../logon';
import {
  encodeLogonChallenge,
  LOGON_OPCODE,
} from '../logon-wire';
import { ProtocolRefusalError } from '../../types';

const CONFIG = {
  host: 'logon.example.com',
  port: 3724,
  game: 'Wow ',
  version: [3, 3, 5] as [number, number, number],
  build: 12340,
  platform: 'x86',
  os: 'Win',
  locale: 'enUS',
  timezone: 0,
};

/** An IO stand-in: records what was sent, replies with whatever the test queues. */
function fakeIo() {
  const sent: Uint8Array[] = [];
  let listener: ((bytes: Uint8Array) => void) | null = null;

  return {
    sent,
    closed: false,
    connect: jest.fn(async () => undefined),
    send(bytes: Uint8Array) {
      sent.push(bytes);
    },
    onMessage(next: (bytes: Uint8Array) => void) {
      listener = next;
    },
    close() {
      this.closed = true;
    },
    reply(bytes: Uint8Array) {
      listener!(bytes);
    },
  };
}

function challengeResponse(code: number): Uint8Array {
  const out = new Uint8Array(3 + 32 + 2 + 32 + 32 + 17);
  out[0] = LOGON_OPCODE.CHALLENGE;
  out[2] = code;
  if (code !== 0x00) {
    return out.slice(0, 3);
  }
  let at = 3;
  for (let i = 0; i < 32; ++i) out[at++] = 0xb1;
  out[at++] = 1;
  out[at++] = 7;
  out[at++] = 1;
  out[at++] = 0x89; // one-byte N keeps SRP arithmetic cheap for the test
  for (let i = 0; i < 32; ++i) out[at++] = 0x51;
  return out;
}

/**
 * A fake SRP session: skips the arithmetic entirely and returns fixed values, which is what makes
 * the successful-handshake path testable without deriving a real, consistent SRP exchange from
 * bytes.
 */
function fakeSrp(overrides: Partial<SrpLike> = {}): SrpLike & { feed: jest.Mock; validate: jest.Mock } {
  return {
    feed: jest.fn(),
    A: { toArray: () => [0xaa, 0xbb] },
    M1: { digest: new Array(20).fill(0x11) },
    K: new Array(40).fill(0x22),
    validate: jest.fn(() => true),
    ...overrides,
  };
}

describe('WotlkLogonTransport', () => {
  it('sends a challenge for the account it was given', async () => {
    const io = fakeIo();
    const transport = new WotlkLogonTransport(io, CONFIG);

    const pending = transport.authenticate('tester', 'secret');
    await Promise.resolve();

    expect(io.connect).toHaveBeenCalledWith('logon.example.com', 3724);
    expect(io.sent[0][0]).toBe(LOGON_OPCODE.CHALLENGE);
    expect(new TextDecoder('latin1').decode(io.sent[0])).toContain('TESTER');

    // Refuse it so the pending promise settles rather than leaking into the next test.
    io.reply(new Uint8Array([LOGON_OPCODE.PROOF, 0x04]));
    await expect(pending).rejects.toBeInstanceOf(ProtocolRefusalError);
  });

  it('rejects with the server’s own code when the challenge is refused', async () => {
    const io = fakeIo();
    const transport = new WotlkLogonTransport(io, CONFIG);

    const pending = transport.authenticate('tester', 'wrong');
    await Promise.resolve();
    io.reply(challengeResponse(0x04));

    await expect(pending).rejects.toMatchObject({
      refusal: { code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' },
    });
  });

  it('asks for the realm list only over an authenticated connection', async () => {
    const io = fakeIo();
    const transport = new WotlkLogonTransport(io, CONFIG);

    await expect(transport.realms()).rejects.toThrow(/authenticate/i);
  });

  it('closes its IO on close', () => {
    const io = fakeIo();
    new WotlkLogonTransport(io, CONFIG).close();

    expect(io.closed).toBe(true);
  });

  it('resolves authenticate() with the session key once the server proof validates', async () => {
    const io = fakeIo();
    const srp = fakeSrp();
    const transport = new WotlkLogonTransport(io, CONFIG, () => srp);

    const pending = transport.authenticate('tester', 'secret');
    await Promise.resolve();

    io.reply(challengeResponse(0x00));

    // A proof should have gone out, built from the fake SRP's A and M1.
    expect(io.sent).toHaveLength(2);
    const proofSent = io.sent[1];
    expect(proofSent[0]).toBe(LOGON_OPCODE.PROOF);
    expect(Array.from(proofSent.slice(1, 3))).toEqual([0xaa, 0xbb]); // A
    expect(Array.from(proofSent.slice(3, 23))).toEqual(new Array(20).fill(0x11)); // M1

    const serverProof = new Uint8Array(22);
    serverProof[0] = LOGON_OPCODE.PROOF;
    serverProof[1] = 0x00; // success
    io.reply(serverProof);

    const result = await pending;

    expect(srp.validate).toHaveBeenCalled();
    expect(Array.from(result.sessionKey)).toEqual(new Array(40).fill(0x22));
  });

  it('rejects a second authenticate() call issued in the same synchronous turn, without leaving the first unsettled', async () => {
    const io = fakeIo();
    const transport = new WotlkLogonTransport(io, CONFIG);

    // No `await` between these two calls: with the real IO, `connect()` is a whole WebSocket
    // handshake, so this window is wide open in production, not a single microtask.
    const first = transport.authenticate('tester', 'secret');
    const second = transport.authenticate('tester', 'secret');

    await expect(second).rejects.toThrow(/already in progress/i);

    // The first call must still be alive and able to settle normally -- the guard must not have
    // clobbered its resolvers.
    await Promise.resolve();
    io.reply(new Uint8Array([LOGON_OPCODE.PROOF, 0x04]));
    await expect(first).rejects.toBeInstanceOf(ProtocolRefusalError);
  });

  it('leaves the transport able to authenticate again after a failed connect', async () => {
    const io = fakeIo();
    io.connect = jest.fn(async () => {
      throw new Error('connect failed');
    });
    const transport = new WotlkLogonTransport(io, CONFIG);

    await expect(transport.authenticate('tester', 'secret')).rejects.toThrow('connect failed');

    // A later, legitimate attempt must not be blocked by the failed one's slot still being held.
    io.connect = jest.fn(async () => undefined);
    const pending = transport.authenticate('tester', 'secret');
    await Promise.resolve();

    expect(io.sent[0][0]).toBe(LOGON_OPCODE.CHALLENGE);

    io.reply(new Uint8Array([LOGON_OPCODE.PROOF, 0x04]));
    await expect(pending).rejects.toBeInstanceOf(ProtocolRefusalError);
  });

  it('rejects a second realms() call made while one is already in flight', async () => {
    const io = fakeIo();
    const srp = fakeSrp();
    const transport = new WotlkLogonTransport(io, CONFIG, () => srp);

    const authPending = transport.authenticate('tester', 'secret');
    await Promise.resolve();
    io.reply(challengeResponse(0x00));
    const serverProof = new Uint8Array(22);
    serverProof[0] = LOGON_OPCODE.PROOF;
    serverProof[1] = 0x00;
    io.reply(serverProof);
    await authPending;

    const firstRealms = transport.realms();
    await expect(transport.realms()).rejects.toThrow(/already in progress/i);

    // Clean up the first pending promise.
    transport.close();
    await expect(firstRealms).rejects.toThrow(/closed/i);
  });

  it('rejects a pending authenticate() when close() is called', async () => {
    const io = fakeIo();
    const transport = new WotlkLogonTransport(io, CONFIG);

    const pending = transport.authenticate('tester', 'secret');
    await Promise.resolve();

    transport.close();

    await expect(pending).rejects.toThrow(/closed/i);
    expect(io.closed).toBe(true);
  });
});
