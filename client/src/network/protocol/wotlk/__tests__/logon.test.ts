/** @jest-environment node */
import { WotlkLogonTransport } from '../logon';
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
});
