/**
 * The realmd (logon) wire format for 3.3.5a, as pure functions over bytes.
 *
 * Every layout here mirrors the working implementation this replaces (`network/auth/handler.js`,
 * `network/realms/handler.js`) -- the value added is purity: a layout you can assert on without a
 * socket, a server, or a login. Nothing in this file opens a connection or holds state.
 */
import { RealmInfo } from '../types';

export const LOGON_OPCODE = {
  CHALLENGE: 0x00,
  PROOF: 0x01,
  REALM_LIST: 0x10,
} as const;

/** Realm flags, from the realmd protocol. */
const REALM_FLAG_INVALID = 0x01;
const REALM_FLAG_OFFLINE = 0x02;
const REALM_FLAG_SPECIFY_BUILD = 0x04;
const REALM_FLAG_RECOMMENDED = 0x20;
/**
 * `icon` is the realm TYPE. 1 and 4 are the PvP variants; 6 and 8 are the RP ones, and 8 is RP-PvP --
 * which is why an RP-PvP realm is in BOTH sets rather than a third one. `realmlist.lua:53-61` branches
 * on `pvp and rp`, `rp`, then `pvp`, so those two booleans are exactly what it needs.
 */
const REALM_TYPE_PVP = new Set([1, 4, 8]);
const REALM_TYPE_RP = new Set([6, 8]);

export type LogonChallengeOptions = {
  account: string;
  game: string;
  version: [number, number, number];
  build: number;
  platform: string;
  os: string;
  locale: string;
  timezone: number;
};

/**
 * The four-character tags travel REVERSED. The client keeps them as little-endian u32s, so "Win"
 * goes out as the bytes `n i W \0`; realmd reverses them back. A tag sent the readable way round is
 * rejected outright.
 *
 * Reverse the value first, then pad the reversed result on the right to four characters with NUL.
 * This implementation mirrors client/src/network/config.ts's raw() function.
 */
function tag(value: string): number[] {
  const reversed = value.split('').reverse().join('');
  const padded = (reversed + '\0').slice(0, 4);
  return Array.from(padded).map((char) => char.charCodeAt(0));
}

function ascii(value: string): number[] {
  return Array.from(value).map((char) => char.charCodeAt(0));
}

export function encodeLogonChallenge(options: LogonChallengeOptions): Uint8Array {
  const account = options.account.toUpperCase();
  const body: number[] = [
    ...ascii(options.game.slice(0, 4)),
    options.version[0],
    options.version[1],
    options.version[2],
    options.build & 0xff,
    (options.build >> 8) & 0xff,
    ...tag(options.platform),
    ...tag(options.os),
    ...tag(options.locale),
    options.timezone & 0xff,
    (options.timezone >> 8) & 0xff,
    (options.timezone >> 16) & 0xff,
    (options.timezone >> 24) & 0xff,
    0,
    0,
    0,
    0, // ip
    account.length,
    ...ascii(account),
  ];

  // Size counts the body only -- 30 fixed bytes plus the account.
  const size = body.length;
  return new Uint8Array([LOGON_OPCODE.CHALLENGE, 0x00, size & 0xff, (size >> 8) & 0xff, ...body]);
}

export type LogonChallenge = {
  code: number;
  B?: Uint8Array;
  g?: Uint8Array;
  N?: Uint8Array;
  salt?: Uint8Array;
};

export function decodeLogonChallenge(bytes: Uint8Array): LogonChallenge {
  // opcode, unknown, result
  const code = bytes[2];
  if (code !== 0x00) {
    return { code };
  }

  let at = 3;
  // A short SUCCESS response must be caught here: an unguarded read past the end returns
  // `undefined` bytes that flow straight into SRP as if they were real data -- a corrupted
  // session key that only ever fails against a live server, with nothing pointing at the cause.
  const need = (length: number, field: string): void => {
    if (bytes.length < at + length) {
      throw new Error(
        `decodeLogonChallenge: truncated success response reading ${field} -- needed ${at + length} bytes, got ${bytes.length}`,
      );
    }
  };
  const take = (length: number, field: string): Uint8Array => {
    need(length, field);
    const slice = bytes.slice(at, at + length);
    at += length;
    return slice;
  };
  const takeLength = (field: string): number => {
    need(1, field);
    return bytes[at++];
  };

  const B = take(32, 'B');
  const g = take(takeLength('g length'), 'g');
  const N = take(takeLength('N length'), 'N');
  const salt = take(32, 'salt');

  return { code, B, g, N, salt };
}

export function encodeLogonProof(proof: { A: Uint8Array; M1: Uint8Array }): Uint8Array {
  return new Uint8Array([
    LOGON_OPCODE.PROOF,
    ...proof.A,
    ...proof.M1,
    ...new Array(20).fill(0), // CRC hash -- servers here do not check it
    0, // number of keys
    0, // security flags
  ]);
}

export function decodeLogonProof(bytes: Uint8Array): { code: number; M2?: Uint8Array } {
  const code = bytes[1];
  if (code !== 0x00) {
    return { code };
  }
  if (bytes.length < 22) {
    throw new Error(
      `decodeLogonProof: truncated success response reading M2 -- needed 22 bytes, got ${bytes.length}`,
    );
  }
  return { code, M2: bytes.slice(2, 22) };
}

export function encodeRealmListRequest(): Uint8Array {
  // The opcode is followed by an unknown u32.
  return new Uint8Array([LOGON_OPCODE.REALM_LIST, 0, 0, 0, 0]);
}

export function decodeRealmList(bytes: Uint8Array): RealmInfo[] {
  // A short response must be caught here: an unguarded read past the end returns `undefined`
  // bytes rather than a clean failure, and nothing about the resulting RealmInfo would look wrong
  // until a player picked the corrupted entry.
  const need = (length: number, at: number, field: string): void => {
    if (bytes.length < at + length) {
      throw new Error(
        `decodeRealmList: truncated response reading ${field} -- needed ${at + length} bytes, got ${bytes.length}`,
      );
    }
  };

  need(2, 7, 'realm count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // opcode(1) + size(2) + unknown(4)
  let at = 7;

  const count = view.getUint16(at, true);
  at += 2;

  /**
   * The realm NAME is UTF-8; the realm ADDRESS is not decoded as text at all.
   *
   * A private server writes whatever its own database holds into the name, and in practice that is
   * UTF-8 -- a Russian realm called "Медив" arrived as its UTF-8 bytes and, decoded as latin1, drew as
   * `ÐœÐµÐ´Ð¸Ð²` on the realm screen. The address stays latin1 because a hostname is ASCII by
   * definition, and there a stray high byte should survive as a visible character in the error rather
   * than collapse into U+FFFD.
   *
   * If some server ever shows replacement characters in a realm name, the likely cause is a core
   * writing windows-1251 rather than UTF-8; that is a second decoder, not a change to this one.
   */
  const readCString = (field: string, encoding: 'utf-8' | 'latin1' = 'utf-8'): string => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) {
      ++end;
    }
    if (end >= bytes.length) {
      throw new Error(
        `decodeRealmList: truncated response reading ${field} -- no NUL terminator found within ${bytes.length} bytes`,
      );
    }
    const text = new TextDecoder(encoding).decode(bytes.slice(at, end));
    at = end + 1;
    return text;
  };

  const realms: RealmInfo[] = [];

  for (let index = 0; index < count; ++index) {
    need(3, at, `realm ${index} header`);
    const icon = bytes[at++];
    // The lock byte. Kept, not skipped: the realm screen's `REALM_LOCKED` ("Locked") column comes from
    // it and from nothing else, so discarding it made a locked realm draw as though it had a normal
    // population -- which is what a reference screenshot of this very screen showed it is not.
    const locked = bytes[at++] !== 0;
    const flags = bytes[at++];
    const name = readCString(`realm ${index} name`);
    const address = readCString(`realm ${index} address`, 'latin1');
    need(7, at, `realm ${index} stats`);
    const population = view.getFloat32(at, true);
    at += 4;
    const characterCount = bytes[at++];
    at++; // timezone
    const id = bytes[at++];

    let build: RealmInfo['build'];
    if (flags & REALM_FLAG_SPECIFY_BUILD) {
      need(5, at, `realm ${index} build`);
      const major = bytes[at++];
      const minor = bytes[at++];
      const patch = bytes[at++];
      const number = view.getUint16(at, true);
      at += 2;
      build = { major, minor, patch, build: number };
    }

    const [host, port] = address.split(':');

    realms.push({
      id,
      name,
      host,
      port: Number(port),
      population,
      characterCount,
      online: (flags & REALM_FLAG_OFFLINE) === 0,
      recommended: (flags & REALM_FLAG_RECOMMENDED) !== 0,
      pvp: REALM_TYPE_PVP.has(icon),
      rp: REALM_TYPE_RP.has(icon),
      locked,
      invalid: (flags & REALM_FLAG_INVALID) !== 0,
      ...(build ? { build } : {}),
    });
  }

  return realms;
}
