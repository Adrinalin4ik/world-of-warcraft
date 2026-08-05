import { WotlkWorldTransport } from '../world';
import { ProtocolRefusalError } from '../../types';
import { CHAR_RESULT } from '../world-wire';

/** A packet-IO stand-in: records sends, lets the test deliver bodies by opcode name. */
function fakeIo() {
  const listeners = new Map<string, (body: Uint8Array) => void>();
  const sent: Array<{ opcode: number; body: Uint8Array }> = [];

  return {
    sent,
    closed: false,
    connect: jest.fn(async () => undefined),
    send(opcode: number, body: Uint8Array) {
      sent.push({ opcode, body });
    },
    on(opcodeName: string, listener: (body: Uint8Array) => void) {
      listeners.set(opcodeName, listener);
    },
    onDisconnect: jest.fn(),
    close() {
      this.closed = true;
    },
    deliver(opcodeName: string, body: Uint8Array) {
      listeners.get(opcodeName)!(body);
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
    const transport = new WotlkWorldTransport(io, { proxyHost: 'localhost', rewriteRealmHost: true });

    const pending = transport.characters();
    io.deliver('SMSG_CHAR_ENUM', new Uint8Array([0])); // zero characters

    await expect(pending).resolves.toEqual([]);
  });

  it('resolves a create on the success byte', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io, { proxyHost: 'localhost', rewriteRealmHost: true });

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
    const transport = new WotlkWorldTransport(io, { proxyHost: 'localhost', rewriteRealmHost: true });

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
    const transport = new WotlkWorldTransport(io, { proxyHost: 'localhost', rewriteRealmHost: true });

    const pending = transport.deleteCharacter('0x1');
    io.deliver('SMSG_CHAR_DELETE', new Uint8Array([CHAR_RESULT.DELETE_SUCCESS]));

    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves entering the world when the world verifies it', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io, { proxyHost: 'localhost', rewriteRealmHost: true });

    const pending = transport.enterWorld('0x1');
    io.deliver('SMSG_LOGIN_VERIFY_WORLD', new Uint8Array(20));

    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects a join when the handshake is refused', async () => {
    const io = fakeIo();
    const transport = new WotlkWorldTransport(io, { proxyHost: 'localhost', rewriteRealmHost: true });

    const pending = transport.join(REALM, 'TESTER', new Uint8Array(40));
    io.deliver('SMSG_AUTH_RESPONSE', new Uint8Array([0x15]));

    await expect(pending).rejects.toBeInstanceOf(ProtocolRefusalError);
  });
});
