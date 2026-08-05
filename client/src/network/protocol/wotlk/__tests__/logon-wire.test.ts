/** @jest-environment node */
import {
  decodeLogonChallenge,
  decodeLogonProof,
  decodeRealmList,
  encodeLogonChallenge,
  encodeLogonProof,
  encodeRealmListRequest,
  LOGON_OPCODE,
} from '../logon-wire';

describe('encodeLogonChallenge', () => {
  const bytes = encodeLogonChallenge({
    account: 'TESTER',
    game: 'Wow ',
    version: [3, 3, 5],
    build: 12340,
    platform: 'x86',
    os: 'Win',
    locale: 'enUS',
    timezone: 0,
  });

  it('opens with the challenge opcode, an error byte and the body size', () => {
    expect(bytes[0]).toBe(LOGON_OPCODE.CHALLENGE);
    expect(bytes[1]).toBe(0x00);
    // Body size counts everything after the size field: 30 + account length.
    expect(bytes[2] | (bytes[3] << 8)).toBe(30 + 'TESTER'.length);
  });

  it('writes the four-character tags REVERSED with NUL padding on the right, not left', () => {
    // The client stores these as little-endian u32s. Tags are reversed, then NUL-padded on the right.
    // Layout after 4-byte header: game(4) + version(3) + build(2) + platform(4) + os(4) + locale(4)
    // Game is NOT reversed, only tags are.

    // Game at bytes 4-7: "Wow " (not reversed)
    expect([bytes[4], bytes[5], bytes[6], bytes[7]]).toEqual([87, 111, 119, 32]); // "Wow "

    // Platform at bytes 13-16: "x86" reversed to "68x\0"
    expect([bytes[13], bytes[14], bytes[15], bytes[16]]).toEqual([54, 56, 120, 0]); // "68x\0"

    // OS at bytes 17-20: "Win" reversed to "niW\0"
    expect([bytes[17], bytes[18], bytes[19], bytes[20]]).toEqual([110, 105, 87, 0]); // "niW\0"

    // Locale at bytes 21-24: "enUS" reversed to "SUne" (already 4 chars, no pad needed)
    expect([bytes[21], bytes[22], bytes[23], bytes[24]]).toEqual([83, 85, 110, 101]); // "SUne"
  });

  it('handles three-character tags: reverses then pads on the right, not left', () => {
    // Test specifically for the bug where padding before reversing puts pad at the front.
    // "Mac" should become "caM\0", not " caM" (the bug would reverse the padded " Mac" to "caM ").
    const bytesWithMac = encodeLogonChallenge({
      account: 'TEST',
      game: 'Wow ',
      version: [3, 3, 5],
      build: 12340,
      platform: 'Mac', // 3 characters - will be reversed and NUL-padded on right
      os: 'Win',
      locale: 'enUS',
      timezone: 0,
    });

    // Platform at bytes 13-16: "Mac" reversed to "caM\0"
    expect([bytesWithMac[13], bytesWithMac[14], bytesWithMac[15], bytesWithMac[16]]).toEqual(
      [99, 97, 77, 0] // "caM\0" - NUL is at the end, not the beginning
    );
  });

  it('carries the version, the build and the account', () => {
    // game(4) + version(3) starts at byte 4.
    expect([bytes[8], bytes[9], bytes[10]]).toEqual([3, 3, 5]);
    expect(bytes[11] | (bytes[12] << 8)).toBe(12340);

    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.endsWith('TESTER')).toBe(true);
    // The account is length-prefixed, not null-terminated.
    expect(bytes[bytes.length - 'TESTER'.length - 1]).toBe('TESTER'.length);
  });
});

describe('decodeLogonChallenge', () => {
  /**
   * A challenge response: opcode, unknown, result, then on success B(32), g(len+value),
   * N(len+value), salt(32), 16 unknown bytes and a security-flag byte.
   */
  function buildChallengeResponse(code: number): Uint8Array {
    if (code !== 0x00) {
      return new Uint8Array([LOGON_OPCODE.CHALLENGE, 0x00, code]);
    }

    const body: number[] = [];
    for (let i = 0; i < 32; ++i) body.push(0xb0 + (i % 16)); // B
    body.push(1, 7); // g length, g
    body.push(32); // N length
    for (let i = 0; i < 32; ++i) body.push(0x30 + (i % 16)); // N
    for (let i = 0; i < 32; ++i) body.push(0x50 + (i % 16)); // salt
    for (let i = 0; i < 16; ++i) body.push(0); // unknown
    body.push(0); // security flags

    return new Uint8Array([LOGON_OPCODE.CHALLENGE, 0x00, code, ...body]);
  }

  it('reads the fields SRP needs on success', () => {
    const decoded = decodeLogonChallenge(buildChallengeResponse(0x00));

    expect(decoded.code).toBe(0x00);
    expect(decoded.B).toHaveLength(32);
    expect(decoded.g).toHaveLength(1);
    expect(decoded.g![0]).toBe(7);
    expect(decoded.N).toHaveLength(32);
    expect(decoded.salt).toHaveLength(32);
  });

  it('reads the code alone on a refusal, with no SRP fields', () => {
    const decoded = decodeLogonChallenge(buildChallengeResponse(0x04));

    expect(decoded.code).toBe(0x04);
    expect(decoded.B).toBeUndefined();
    expect(decoded.salt).toBeUndefined();
  });
});

describe('proof', () => {
  it('writes A, M1 and the trailing zero fields', () => {
    const A = new Uint8Array(32).fill(0xaa);
    const M1 = new Uint8Array(20).fill(0x11);
    const bytes = encodeLogonProof({ A, M1 });

    expect(bytes[0]).toBe(LOGON_OPCODE.PROOF);
    expect(bytes.slice(1, 33)).toEqual(A);
    expect(bytes.slice(33, 53)).toEqual(M1);
    // 20 bytes of CRC, then key count and security flags.
    expect(bytes).toHaveLength(1 + 32 + 20 + 20 + 1 + 1);
  });

  it('reads the server proof on success and the code on refusal', () => {
    const ok = new Uint8Array(1 + 1 + 20);
    ok[0] = LOGON_OPCODE.PROOF;
    ok[1] = 0x00;
    ok.fill(0x22, 2);
    const decoded = decodeLogonProof(ok);
    expect(decoded.code).toBe(0x00);
    expect(decoded.M2).toHaveLength(20);

    const bad = new Uint8Array([LOGON_OPCODE.PROOF, 0x04]);
    expect(decodeLogonProof(bad)).toEqual({ code: 0x04 });
  });
});

describe('decodeRealmList', () => {
  function buildRealmList(): Uint8Array {
    const parts: number[] = [];
    const push = (...values: number[]) => parts.push(...values);
    const pushString = (text: string) => {
      for (const char of text) push(char.charCodeAt(0));
      push(0);
    };
    const pushU16 = (value: number) => push(value & 0xff, (value >> 8) & 0xff);
    const pushU32 = (value: number) => push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
    const pushF32 = (value: number) => {
      const buffer = new DataView(new ArrayBuffer(4));
      buffer.setFloat32(0, value, true);
      for (let i = 0; i < 4; ++i) push(buffer.getUint8(i));
    };

    push(LOGON_OPCODE.REALM_LIST);
    pushU16(0); // size, unread by the decoder
    pushU32(0); // unknown
    pushU16(2); // realm count

    // Realm 1: online PvP realm that does NOT advertise a build.
    push(0x01); // icon: 1 = PvP
    push(0x00); // lock
    push(0x00); // flags
    pushString('Blackrock');
    pushString('logon.example.com:8085');
    pushF32(1.5);
    push(3); // characters
    push(1); // timezone
    push(7); // id

    // Realm 2: offline, recommended, advertises a build.
    push(0x00);
    push(0x00);
    push(0x06); // flags: 0x02 offline | 0x04 specify-build
    pushString('Lordaeron');
    pushString('other.example.com:8086');
    pushF32(0.25);
    push(0);
    push(0);
    push(9);
    push(3, 3, 5);
    pushU16(12340);

    return new Uint8Array(parts);
  }

  it('reads every realm, splitting host from port', () => {
    const realms = decodeRealmList(buildRealmList());

    expect(realms).toHaveLength(2);
    expect(realms[0]).toMatchObject({
      id: 7,
      name: 'Blackrock',
      host: 'logon.example.com',
      port: 8085,
      characterCount: 3,
      pvp: true,
      online: true,
    });
    expect(realms[0].build).toBeUndefined();
    expect(realms[0].population).toBeCloseTo(1.5);
  });

  it('reads the advertised build only for the realm that carries one', () => {
    const realms = decodeRealmList(buildRealmList());

    expect(realms[1].name).toBe('Lordaeron');
    expect(realms[1].online).toBe(false);
    expect(realms[1].build).toEqual({ major: 3, minor: 3, patch: 5, build: 12340 });
  });
});

describe('encodeRealmListRequest', () => {
  it('is the opcode plus the four unknown bytes the protocol expects', () => {
    const bytes = encodeRealmListRequest();

    expect(bytes[0]).toBe(LOGON_OPCODE.REALM_LIST);
    expect(bytes).toHaveLength(5);
  });
});
