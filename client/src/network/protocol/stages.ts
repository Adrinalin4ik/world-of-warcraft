/**
 * The session's stages, and the server's result codes in the client's own vocabulary.
 *
 * The KEY NAMES here are verified present in the shipped `interface/gluexml/gluestrings.lua`; the
 * words they resolve to are the client's, fetched at runtime. Pairing a numeric code with a key is
 * our reading of the server's table, and the two the existing client already acts on (`0x0d`,
 * `0x15` in `game/handler.js`) corroborate the WotLK ordering where `AUTH_OK` is `0x0c`.
 *
 * Deliberately table-driven and pure: two screens need the same mapping, and an unmapped code must
 * fall back to something the player can SEE rather than to a blank dialog.
 */
import { ProtocolRefusal } from './types';

export enum LoginStage {
  Offline = 'Offline',
  Connecting = 'Connecting',
  Authenticating = 'Authenticating',
  RealmList = 'RealmList',
  JoiningRealm = 'JoiningRealm',
  CharacterList = 'CharacterList',
  EnteringWorld = 'EnteringWorld',
  InWorld = 'InWorld',
}

/** Shown when a code has no mapping of its own. */
export const FALLBACK_STRING_KEY = 'AUTH_FAILED';

/** Realmd (logon) result bytes -- values from `network/auth/challenge-opcode.js`. */
export const LOGON_RESULT_STRINGS: Record<number, string> = {
  0x00: 'AUTH_OK',
  0x03: 'AUTH_BANNED',
  0x04: 'AUTH_UNKNOWN_ACCOUNT',
  0x05: 'AUTH_INCORRECT_PASSWORD',
  0x06: 'AUTH_ALREADY_ONLINE',
  0x07: 'AUTH_NO_TIME',
  0x08: 'AUTH_DB_BUSY',
  0x09: 'AUTH_VERSION_MISMATCH',
  0x0a: 'AUTH_VERSION_MISMATCH',
  0x0b: 'AUTH_LOGIN_SERVER_NOT_FOUND',
  0x0c: 'AUTH_SUSPENDED',
  0x0d: 'AUTH_FAILED',
  0x0e: 'AUTH_OK',
  0x0f: 'AUTH_PARENTAL_CONTROL',
  0x10: 'AUTH_LOCKED_ENFORCED',
  0x11: 'AUTH_BILLING_EXPIRED',
  0x12: 'AUTH_REJECT',
};

/** World handshake (`SMSG_AUTH_RESPONSE`) result bytes. */
export const WORLD_RESULT_STRINGS: Record<number, string> = {
  0x0c: 'AUTH_OK',
  0x0d: 'AUTH_FAILED',
  0x0e: 'AUTH_REJECT',
  0x0f: 'AUTH_BAD_SERVER_PROOF',
  0x10: 'AUTH_UNAVAILABLE',
  0x11: 'AUTH_SYSTEM_ERROR',
  0x12: 'AUTH_BILLING_ERROR',
  0x13: 'AUTH_BILLING_EXPIRED',
  0x14: 'AUTH_VERSION_MISMATCH',
  0x15: 'AUTH_UNKNOWN_ACCOUNT',
  0x16: 'AUTH_INCORRECT_PASSWORD',
  0x17: 'AUTH_SESSION_EXPIRED',
  0x1a: 'AUTH_WAIT_QUEUE',
};

function refusal(table: Record<number, string>, code: number): ProtocolRefusal {
  return { code, stringKey: table[code] ?? FALLBACK_STRING_KEY };
}

export function logonRefusal(code: number): ProtocolRefusal {
  return refusal(LOGON_RESULT_STRINGS, code);
}

export function worldRefusal(code: number): ProtocolRefusal {
  return refusal(WORLD_RESULT_STRINGS, code);
}

/** The logon success byte -- `0x0e` (survey) is also a pass. */
export function isLogonSuccess(code: number): boolean {
  return code === 0x00 || code === 0x0e;
}

/** The world handshake's success byte. */
export function isWorldSuccess(code: number): boolean {
  return code === 0x0c;
}
