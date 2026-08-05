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
const REALM_FLAG_OFFLINE = 0x02;
const REALM_FLAG_SPECIFY_BUILD = 0x04;
const REALM_FLAG_RECOMMENDED = 0x20;
/** `icon` is the realm TYPE: 1 and 4 are PvP variants. */
const REALM_TYPE_PVP = new Set([1, 4]);

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
 */
function tag(value: string): number[] {
  const padded = `${value} `.slice(0, 4);
  return Array.from(padded).reverse().map((char) => char.charCodeAt(0));
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
  const take = (length: number): Uint8Array => {
    const slice = bytes.slice(at, at + length);
    at += length;
    return slice;
  };

  const B = take(32);
  const g = take(bytes[at++]);
  const N = take(bytes[at++]);
  const salt = take(32);

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
  return { code, M2: bytes.slice(2, 22) };
}

export function encodeRealmListRequest(): Uint8Array {
  // The opcode is followed by an unknown u32.
  return new Uint8Array([LOGON_OPCODE.REALM_LIST, 0, 0, 0, 0]);
}

export function decodeRealmList(bytes: Uint8Array): RealmInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // opcode(1) + size(2) + unknown(4)
  let at = 7;

  const count = view.getUint16(at, true);
  at += 2;

  const readCString = (): string => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) {
      ++end;
    }
    const text = new TextDecoder('latin1').decode(bytes.slice(at, end));
    at = end + 1;
    return text;
  };

  const realms: RealmInfo[] = [];

  for (let index = 0; index < count; ++index) {
    const icon = bytes[at++];
    at++; // lock
    const flags = bytes[at++];
    const name = readCString();
    const address = readCString();
    const population = view.getFloat32(at, true);
    at += 4;
    const characterCount = bytes[at++];
    at++; // timezone
    const id = bytes[at++];

    let build: RealmInfo['build'];
    if (flags & REALM_FLAG_SPECIFY_BUILD) {
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
      ...(build ? { build } : {}),
    });
  }

  return realms;
}
