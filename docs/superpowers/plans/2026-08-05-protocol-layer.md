# Protocol Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pre-world session a typed shape a screen can build on — logon, realm list, world handshake, character roster, character create and delete — behind a version-neutral interface with one 3.3.5 implementation.

**Architecture:** Wire encoding and decoding become PURE functions over byte buffers (`*-wire.ts`), so every packet layout is testable offline with hand-built buffers. Two thin transports drive those functions over the existing sockets and crypto. A version-neutral session state machine sequences the transports and owns the retry and error policy; it never imports anything build-specific. The existing handlers keep working untouched, so the current screens keep working until spec 3 replaces them.

**Tech Stack:** TypeScript, `byte-buffer` (the existing packet base), the existing SRP6 and RC4-HMAC crypto, jest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-protocol-layer-design.md`. Read it before Task 1.
- Client build is **3.3.5a (12340)**. Every build-specific byte lives under `protocol/wotlk/`; nothing build-specific may appear in `types.ts`, `stages.ts` or `session.ts`.
- **Do not touch** `crypto/` (SRP6, the RC4-HMAC crypt, big-num, sha1), `net/socket.js`, `net/packet.js`, `game/packet.js` or `game/opcode.js`. They work; this plan re-shapes what surrounds them.
- **Additive, not destructive.** `auth/handler.js`, `realms/handler.js`, `characters/handler.js` and `game/handler.js` stay in place and keep working for the whole of this plan. `/`, `/realms`, `/characters`, `/game` and `/game?offline=1` must behave exactly as they do today, at every task boundary. Spec 3 removes the old path when the new screens replace it.
- **A refusal never retries.** A wrong password must not be resubmitted: on vmangos an `0x05` locks the account out, which is why the server answers unknown-account and wrong-password with the same `0x04`.
- No `alert()`. No bare `emit('reject')`. Every failure is a typed rejection carrying the server's own result code.
- Run one test file: `cd client && npm test -- --watchAll=false --testPathPattern=<pattern>`. First run in a session takes ~20-40s.
- Commit after every task.

---

### Task 1: Version-neutral types, the login stages, and the endpoint policy

**Files:**
- Create: `client/src/network/protocol/types.ts`
- Create: `client/src/network/protocol/stages.ts`
- Create: `client/src/network/protocol/endpoint.ts`
- Test: `client/src/network/protocol/__tests__/stages.test.ts`
- Test: `client/src/network/protocol/__tests__/endpoint.test.ts`

**Interfaces:**
- Produces: from `types.ts` — `RealmInfo`, `EquipmentDisplay`, `CharacterAppearance`, `CharacterRecord`, `CharCreateRequest`, `ProtocolRefusal`, `LogonTransport`, `WorldTransport`; from `stages.ts` — `enum LoginStage`, `logonRefusal(code): ProtocolRefusal`, `worldRefusal(code): ProtocolRefusal`, `LOGON_RESULT_STRINGS`, `WORLD_RESULT_STRINGS`; from `endpoint.ts` -- `type ProxyConfig = { proxyHost: string; rewriteRealmHost: boolean }`, `resolveRealmEndpoint(realm, config): { host: string; port: number }`.

- [ ] **Step 1: Write the failing test**

```ts
import {
  LoginStage,
  LOGON_RESULT_STRINGS,
  logonRefusal,
  worldRefusal,
} from '../stages';

describe('logonRefusal', () => {
  it('names the codes the realmd protocol actually sends', () => {
    // Values from the client's own table (`network/auth/challenge-opcode.js`); key names verified
    // present in the shipped `interface/gluexml/gluestrings.lua`.
    expect(logonRefusal(0x03)).toEqual({ code: 0x03, stringKey: 'AUTH_BANNED' });
    expect(logonRefusal(0x04)).toEqual({ code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' });
    expect(logonRefusal(0x05)).toEqual({ code: 0x05, stringKey: 'AUTH_INCORRECT_PASSWORD' });
    expect(logonRefusal(0x06)).toEqual({ code: 0x06, stringKey: 'AUTH_ALREADY_ONLINE' });
    expect(logonRefusal(0x09)).toEqual({ code: 0x09, stringKey: 'AUTH_VERSION_MISMATCH' });
    expect(logonRefusal(0x0c)).toEqual({ code: 0x0c, stringKey: 'AUTH_SUSPENDED' });
  });

  it('falls back to a visible string for a code nobody mapped', () => {
    // A blank dialog is the one unacceptable outcome: the player must see SOMETHING.
    expect(logonRefusal(0x7f)).toEqual({ code: 0x7f, stringKey: 'AUTH_FAILED' });
  });

  it('keeps every mapped key resolvable rather than inventing wording', () => {
    // The table may only name keys; the words come from GlueStrings at runtime.
    Object.values(LOGON_RESULT_STRINGS).forEach((key) => {
      expect(key).toMatch(/^AUTH_[A-Z_]+$/);
    });
  });
});

describe('worldRefusal', () => {
  it('names the world handshake codes the existing client already acts on', () => {
    // `network/game/handler.js` checks exactly 0x0d and 0x15 today, which corroborates the WotLK
    // ResponseCodes ordering where AUTH_OK is 0x0c.
    expect(worldRefusal(0x0d)).toEqual({ code: 0x0d, stringKey: 'AUTH_FAILED' });
    expect(worldRefusal(0x15)).toEqual({ code: 0x15, stringKey: 'AUTH_UNKNOWN_ACCOUNT' });
    expect(worldRefusal(0x16)).toEqual({ code: 0x16, stringKey: 'AUTH_INCORRECT_PASSWORD' });
  });

  it('falls back for an unmapped code', () => {
    expect(worldRefusal(0xee).stringKey).toBe('AUTH_FAILED');
  });
});

describe('LoginStage', () => {
  it('runs from offline to in-world in the order the exchanges happen', () => {
    expect(Object.values(LoginStage)).toEqual([
      'Offline',
      'Connecting',
      'Authenticating',
      'RealmList',
      'JoiningRealm',
      'CharacterList',
      'EnteringWorld',
      'InWorld',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=protocol/__tests__/stages`
Expected: FAIL — cannot resolve `../stages`.

- [ ] **Step 3: Write `types.ts`**

```ts
/**
 * The protocol layer's version-neutral vocabulary.
 *
 * Nothing here may name a build. The seam is only real if a 1.12.1 implementation can satisfy these
 * types without bending them, so three known differences are deliberately absent: the logon
 * challenge body, the world handshake's digest input and addon block, and the number of equipment
 * slots in a character record (vanilla enumerates 19 plus a bag, WotLK 23 — hence a LIST).
 */

export type RealmInfo = {
  id: number;
  name: string;
  /** Host without the port, as the realm advertises it. */
  host: string;
  port: number;
  /** The server's own load figure. Lower is lighter; the scale is the server's, not ours. */
  population: number;
  characterCount: number;
  online: boolean;
  recommended: boolean;
  pvp: boolean;
  /** Present only when the realm advertises a build. Absent is normal, not an error. */
  build?: { major: number; minor: number; patch: number; build: number };
};

export type EquipmentDisplay = {
  displayId: number;
  inventoryType: number;
  enchantmentId: number;
};

/** The five dials the create screen edits and the roster reports. */
export type CharacterAppearance = {
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
};

export type CharacterRecord = {
  /** Hex string: a 64-bit guid does not survive a JS number. */
  guid: string;
  name: string;
  race: number;
  class: number;
  gender: number;
  level: number;
  appearance: CharacterAppearance;
  zoneId: number;
  mapId: number;
  position: [number, number, number];
  guildId: number;
  flags: number;
  /** As many slots as the build enumerates. Consumers read what is there. */
  equipment: EquipmentDisplay[];
  pet?: { displayId: number; level: number; family: number };
};

export type CharCreateRequest = {
  name: string;
  race: number;
  class: number;
  gender: number;
  appearance: CharacterAppearance;
  /** The starting-outfit id the create screen picked. */
  outfitId: number;
};

/**
 * A refusal from the server, typed so the UI can say it in the client's own words. `stringKey` is a
 * key into `GlueStrings` -- this layer never holds user-visible wording.
 */
export type ProtocolRefusal = {
  code: number;
  stringKey: string;
};

/** Thrown/rejected with, so a caller can `instanceof` it rather than sniff shapes. */
export class ProtocolRefusalError extends Error {
  readonly refusal: ProtocolRefusal;

  constructor(refusal: ProtocolRefusal) {
    super(`server refused: ${refusal.stringKey} (${refusal.code})`);
    this.name = 'ProtocolRefusalError';
    this.refusal = refusal;
  }
}

export interface LogonTransport {
  /** Opens the logon socket and runs challenge + proof. Rejects with `ProtocolRefusalError`. */
  authenticate(account: string, password: string): Promise<{ sessionKey: Uint8Array }>;
  realms(): Promise<RealmInfo[]>;
  close(): void;
}

export interface WorldTransport {
  join(realm: RealmInfo, account: string, sessionKey: Uint8Array): Promise<void>;
  characters(): Promise<CharacterRecord[]>;
  createCharacter(request: CharCreateRequest): Promise<void>;
  deleteCharacter(guid: string): Promise<void>;
  /** Resolves when the world confirms the login. */
  enterWorld(guid: string): Promise<void>;
  close(): void;
  onDisconnect(listener: (reason: string) => void): void;
}
```

- [ ] **Step 4: Write `stages.ts`**

```ts
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
```

- [ ] **Step 5: Write the endpoint test**

```ts
import { resolveRealmEndpoint } from '../endpoint';

const REALM = {
  id: 1,
  name: 'Blackrock',
  host: '95.181.139.52',
  port: 8086,
  population: 1,
  characterCount: 0,
  online: true,
  recommended: false,
  pvp: false,
};

describe('resolveRealmEndpoint', () => {
  it('keeps the realm port and substitutes the proxy host', () => {
    // A browser cannot open a raw TCP socket: the realm's advertised address has no WebSocket
    // listener, and `client/websockify.js` is what bridges the two. This is the convention the
    // existing client relies on silently -- `realms.tsx` passes the AUTH host with the realm.
    expect(resolveRealmEndpoint(REALM, { proxyHost: 'localhost', rewriteRealmHost: true })).toEqual({
      host: 'localhost',
      port: 8086,
    });
  });

  it('honours the realm address as advertised when told to', () => {
    // A deployment that terminates WebSockets at the realm itself needs no rewriting.
    expect(resolveRealmEndpoint(REALM, { proxyHost: 'localhost', rewriteRealmHost: false })).toEqual({
      host: '95.181.139.52',
      port: 8086,
    });
  });
});
```

- [ ] **Step 6: Write `endpoint.ts`**

```ts
/**
 * Where the browser may actually connect.
 *
 * A browser has no raw TCP, so every game connection goes through the WebSocket-to-TCP proxy in
 * `client/websockify.js` -- one process per (listen port -> target). The realm list advertises the
 * SERVER's address, which has no WebSocket listener, so by default we keep the realm's port and
 * substitute the proxy host. That is exactly what the existing client does by passing the auth host
 * along with the realm; writing it down here makes it a decision rather than an accident.
 *
 * A realm on a port no proxy listens on cannot be reached from a browser at all. This function
 * cannot fix that -- but every failure out of the transports names the endpoint it tried, so the
 * cause is visible rather than mysterious.
 */
import { RealmInfo } from './types';

export type ProxyConfig = {
  /** The host the WebSocket proxies listen on. */
  proxyHost: string;
  /** False when WebSockets terminate at the realm itself and no rewriting is wanted. */
  rewriteRealmHost: boolean;
};

export function resolveRealmEndpoint(
  realm: RealmInfo,
  config: ProxyConfig,
): { host: string; port: number } {
  return {
    host: config.rewriteRealmHost ? config.proxyHost : realm.host,
    port: realm.port,
  };
}
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern="protocol/__tests__/(stages|endpoint)"`
Expected: PASS (8 tests)

- [ ] **Step 8: Commit**

```bash
git add client/src/network/protocol
git commit -m "feat(protocol): add version-neutral types, stages and the endpoint policy"
```

---

### Task 2: Logon wire codec

**Files:**
- Create: `client/src/network/protocol/wotlk/logon-wire.ts`
- Test: `client/src/network/protocol/wotlk/__tests__/logon-wire.test.ts`

**Interfaces:**
- Consumes: `RealmInfo` from `../types`.
- Produces: `LOGON_OPCODE` (`{ CHALLENGE: 0x00, PROOF: 0x01, REALM_LIST: 0x10 }`), `encodeLogonChallenge(opts): Uint8Array`, `decodeLogonChallenge(bytes): { code: number; B?: Uint8Array; g?: Uint8Array; N?: Uint8Array; salt?: Uint8Array }`, `encodeLogonProof({ A, M1 }): Uint8Array`, `decodeLogonProof(bytes): { code: number; M2?: Uint8Array }`, `encodeRealmListRequest(): Uint8Array`, `decodeRealmList(bytes): RealmInfo[]`.

**Byte layouts** — these mirror the WORKING implementation in `network/auth/handler.js` and `network/realms/handler.js`. Do not redesign them; the point of this task is to make them pure and testable.

- [ ] **Step 1: Write the failing test**

```ts
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

  it('writes the four-character tags REVERSED, as the wire wants them', () => {
    // The client stores these as little-endian u32s, so "Win" reaches the server as "niW\0".
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('Wow ');
    expect(text).toContain('68x'); // x86 reversed
    expect(text).toContain('niW'); // Win reversed
    expect(text).toContain('SUne'); // enUS reversed
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=logon-wire`
Expected: FAIL — cannot resolve `../logon-wire`.

- [ ] **Step 3: Write the implementation**

```ts
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
  const padded = `${value} `.slice(0, 4);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=logon-wire`
Expected: PASS (9 tests)

- [ ] **Step 5: Cross-check against the code being replaced**

Read `client/src/network/auth/handler.js` and `client/src/network/realms/handler.js` side by side with your implementation and confirm field-for-field that you write and read the same bytes in the same order. Write what you compared in your report — a layout that passes a test you wrote yourself but disagrees with the working client is the failure mode this step exists to catch.

- [ ] **Step 6: Commit**

```bash
git add client/src/network/protocol/wotlk
git commit -m "feat(protocol): add the 3.3.5 logon wire codec as pure functions"
```

---

### Task 3: World wire codec

**Files:**
- Create: `client/src/network/protocol/wotlk/world-wire.ts`
- Test: `client/src/network/protocol/wotlk/__tests__/world-wire.test.ts`

**Interfaces:**
- Consumes: `CharacterRecord`, `CharCreateRequest`, `EquipmentDisplay` from `../types`.
- Produces: `decodeCharEnum(bytes): CharacterRecord[]`, `encodeCharCreateBody(request): Uint8Array`, `encodeGuidBody(guid): Uint8Array`, `decodeResultByte(bytes): number`, `CHAR_RESULT` (`{ CREATE_SUCCESS: 0x2e, DELETE_SUCCESS: 0x3a }`), `CHAR_CREATE_STRINGS`, `CHAR_DELETE_STRINGS`, `charCreateRefusal(code)`, `charDeleteRefusal(code)`.

**The one unverifiable table in this plan.** The `CHAR_CREATE_*` and `CHAR_DELETE_*` numeric codes are not in this repository: `server/src` holds only a cluster launcher and config, and `samples/benilla` is 1.12.1, whose values differ. The key NAMES are verified in `gluestrings.lua`; the numbers below follow the WotLK `ResponseCodes` ordering that the existing client corroborates at two points (`0x0d`/`0x15` in `game/handler.js`, consistent with `AUTH_OK = 0x0c`). Treat them as **provisional**: they are the best available reading, they are isolated in one table, and the manual check in Task 6 against a live server is what confirms or corrects them. Say so in your report rather than presenting them as verified.

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import {
  CHAR_RESULT,
  charCreateRefusal,
  decodeCharEnum,
  encodeCharCreateBody,
  encodeGuidBody,
} from '../world-wire';

/**
 * A char-enum body, laid out as 3.3.5 sends it: count, then per character guid(8), name cstring,
 * race, class, gender, appearance u32, facial hair, level, zone u32, map u32, x/y/z f32, guild u32,
 * flags u32, customization u32, first-login u8, pet display/level/family u32, then 23 equipment
 * slots of display u32 + inventory type u8 + enchantment u32.
 */
function buildCharEnum(): Uint8Array {
  const parts: number[] = [];
  const push = (...values: number[]) => parts.push(...values);
  const pushU32 = (value: number) =>
    push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  const pushF32 = (value: number) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let i = 0; i < 4; ++i) push(view.getUint8(i));
  };
  const pushString = (text: string) => {
    for (const char of text) push(char.charCodeAt(0));
    push(0);
  };
  const pushCharacter = (name: string, petDisplay: number) => {
    push(1, 0, 0, 0, 0, 0, 0, 0); // guid low byte 1
    pushString(name);
    push(1); // race: human
    push(2); // class: paladin
    push(0); // gender: male
    // appearance u32: skin 3, face 4, hair style 5, hair colour 6
    pushU32(3 | (4 << 8) | (5 << 16) | (6 << 24));
    push(7); // facial hair
    push(80); // level
    pushU32(12); // zone
    pushU32(0); // map
    pushF32(-8949.95);
    pushF32(-132.49);
    pushF32(83.53);
    pushU32(0); // guild
    pushU32(0); // flags
    pushU32(0); // customization flags
    push(0); // first login
    pushU32(petDisplay);
    pushU32(petDisplay ? 70 : 0);
    pushU32(petDisplay ? 1 : 0);
    for (let slot = 0; slot < 23; ++slot) {
      pushU32(slot === 0 ? 1234 : 0); // display id
      push(slot === 0 ? 4 : 0); // inventory type
      pushU32(0); // enchantment
    }
  };

  push(2); // two characters
  pushCharacter('Arthas', 0);
  pushCharacter('Jaina', 4567);

  return new Uint8Array(parts);
}

describe('decodeCharEnum', () => {
  // Decoded once here rather than at describe-body level: a throw in the body fails the whole file
  // with a confusing message instead of failing one test.
  let characters: ReturnType<typeof decodeCharEnum>;

  beforeAll(() => {
    characters = decodeCharEnum(buildCharEnum());
  });

  it('reads both characters', () => {
    expect(characters.map((character) => character.name)).toEqual(['Arthas', 'Jaina']);
  });

  it('unpacks the appearance dials out of the packed u32', () => {
    expect(characters[0].appearance).toEqual({
      skin: 3,
      face: 4,
      hairStyle: 5,
      hairColor: 6,
      facialHair: 7,
    });
  });

  it('keeps the guid as a string rather than a lossy number', () => {
    expect(typeof characters[0].guid).toBe('string');
    expect(characters[0].guid).toMatch(/^0x[0-9a-f]+$/);
  });

  it('reads the position and level', () => {
    expect(characters[0].level).toBe(80);
    expect(characters[0].position[0]).toBeCloseTo(-8949.95, 1);
  });

  it('reports equipment as a list, and its populated slots', () => {
    expect(characters[0].equipment).toHaveLength(23);
    expect(characters[0].equipment[0]).toEqual({
      displayId: 1234,
      inventoryType: 4,
      enchantmentId: 0,
    });
  });

  it('omits the pet entirely when there is none, and reports one when there is', () => {
    expect(characters[0].pet).toBeUndefined();
    expect(characters[1].pet).toEqual({ displayId: 4567, level: 70, family: 1 });
  });
});

describe('encodeCharCreateBody', () => {
  it('writes the name, the class fields and the five dials in order', () => {
    const bytes = encodeCharCreateBody({
      name: 'Newbie',
      race: 4,
      class: 3,
      gender: 1,
      appearance: { skin: 5, face: 6, hairStyle: 7, hairColor: 8, facialHair: 9 },
      outfitId: 0,
    });

    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('Newbie ')).toBe(true);

    const after = 'Newbie'.length + 1;
    expect(Array.from(bytes.slice(after))).toEqual([4, 3, 1, 5, 6, 7, 8, 9, 0]);
  });
});

describe('encodeGuidBody', () => {
  it('writes a guid as eight little-endian bytes -- delete and player-login share this body', () => {
    expect(Array.from(encodeGuidBody('0x1'))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('charCreateRefusal', () => {
  it("names a refusal with the client's own key", () => {
    expect(charCreateRefusal(0x31)).toEqual({ code: 0x31, stringKey: 'CHAR_CREATE_NAME_IN_USE' });
  });

  it('falls back visibly for an unmapped code', () => {
    expect(charCreateRefusal(0x99).stringKey).toBe('CHAR_CREATE_ERROR');
  });

  it('knows which byte means success', () => {
    expect(CHAR_RESULT.CREATE_SUCCESS).toBe(0x2e);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=world-wire`
Expected: FAIL — cannot resolve `../world-wire`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The world server's character-management wire format for 3.3.5a, as pure functions over bytes.
 *
 * The char-enum layout mirrors the working parse in `network/characters/handler.js`; create and
 * delete are new. Bodies only -- the opcode and the encrypted header are the transport's business.
 */
import { CharacterRecord, CharCreateRequest, EquipmentDisplay, ProtocolRefusal } from '../types';

/** Equipment slots a 3.3.5 roster enumerates. Vanilla sends fewer; consumers read the list length. */
const EQUIPMENT_SLOTS = 23;

export const CHAR_RESULT = {
  CREATE_SUCCESS: 0x2e,
  DELETE_SUCCESS: 0x3a,
} as const;

/**
 * PROVISIONAL. The key names are verified in the shipped `gluestrings.lua`; the numeric codes follow
 * the WotLK `ResponseCodes` ordering (corroborated at `AUTH_OK = 0x0c` by the two codes the existing
 * client already acts on) but are not verifiable from anything in this repository. A live server
 * confirms or corrects them; they are isolated here so that correction is a one-file edit.
 */
export const CHAR_CREATE_STRINGS: Record<number, string> = {
  0x2d: 'CHAR_CREATE_IN_PROGRESS',
  0x2e: 'CHAR_CREATE_SUCCESS',
  0x2f: 'CHAR_CREATE_ERROR',
  0x30: 'CHAR_CREATE_FAILED',
  0x31: 'CHAR_CREATE_NAME_IN_USE',
  0x32: 'CHAR_CREATE_DISABLED',
  0x33: 'CHAR_CREATE_PVP_TEAMS_VIOLATION',
  0x34: 'CHAR_CREATE_SERVER_LIMIT',
  0x35: 'CHAR_CREATE_ACCOUNT_LIMIT',
  0x36: 'CHAR_CREATE_SERVER_QUEUE',
  0x37: 'CHAR_CREATE_ONLY_EXISTING',
  0x38: 'CHAR_CREATE_EXPANSION',
};

export const CHAR_DELETE_STRINGS: Record<number, string> = {
  0x39: 'CHAR_DELETE_IN_PROGRESS',
  0x3a: 'CHAR_DELETE_SUCCESS',
  0x3b: 'CHAR_DELETE_FAILED',
  0x3c: 'CHAR_DELETE_FAILED_LOCKED_FOR_TRANSFER',
};

export function charCreateRefusal(code: number): ProtocolRefusal {
  return { code, stringKey: CHAR_CREATE_STRINGS[code] ?? 'CHAR_CREATE_ERROR' };
}

export function charDeleteRefusal(code: number): ProtocolRefusal {
  return { code, stringKey: CHAR_DELETE_STRINGS[code] ?? 'CHAR_DELETE_FAILED' };
}

/** Both `SMSG_CHAR_CREATE` and `SMSG_CHAR_DELETE` are a single result byte. */
export function decodeResultByte(bytes: Uint8Array): number {
  return bytes[0];
}

export function decodeCharEnum(bytes: Uint8Array): CharacterRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;

  const u8 = (): number => bytes[at++];
  const u32 = (): number => {
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const f32 = (): number => {
    const value = view.getFloat32(at, true);
    at += 4;
    return value;
  };
  const guid = (): string => {
    // Little-endian 64-bit. Kept as a hex string: a guid does not survive a JS number.
    let hex = '';
    for (let i = 7; i >= 0; --i) {
      hex += bytes[at + i].toString(16).padStart(2, '0');
    }
    at += 8;
    return `0x${hex.replace(/^0+(?=.)/, '')}`;
  };
  const cstring = (): string => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) {
      ++end;
    }
    const text = new TextDecoder('latin1').decode(bytes.slice(at, end));
    at = end + 1;
    return text;
  };

  const count = u8();
  const characters: CharacterRecord[] = [];

  for (let index = 0; index < count; ++index) {
    const record: CharacterRecord = {
      guid: guid(),
      name: cstring(),
      race: u8(),
      class: u8(),
      gender: u8(),
      appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
      level: 0,
      zoneId: 0,
      mapId: 0,
      position: [0, 0, 0],
      guildId: 0,
      flags: 0,
      equipment: [],
    };

    const packed = u32();
    record.appearance = {
      skin: packed & 0xff,
      face: (packed >> 8) & 0xff,
      hairStyle: (packed >> 16) & 0xff,
      hairColor: (packed >> 24) & 0xff,
      facialHair: u8(),
    };

    record.level = u8();
    record.zoneId = u32();
    record.mapId = u32();
    record.position = [f32(), f32(), f32()];
    record.guildId = u32();
    record.flags = u32();

    u32(); // customization flags
    u8(); // first login

    const petDisplayId = u32();
    const petLevel = u32();
    const petFamily = u32();
    if (petDisplayId) {
      record.pet = { displayId: petDisplayId, level: petLevel, family: petFamily };
    }

    const equipment: EquipmentDisplay[] = [];
    for (let slot = 0; slot < EQUIPMENT_SLOTS; ++slot) {
      equipment.push({ displayId: u32(), inventoryType: u8(), enchantmentId: u32() });
    }
    record.equipment = equipment;

    characters.push(record);
  }

  return characters;
}

export function encodeCharCreateBody(request: CharCreateRequest): Uint8Array {
  const name = Array.from(request.name).map((char) => char.charCodeAt(0));

  return new Uint8Array([
    ...name,
    0,
    request.race,
    request.class,
    request.gender,
    request.appearance.skin,
    request.appearance.face,
    request.appearance.hairStyle,
    request.appearance.hairColor,
    request.appearance.facialHair,
    request.outfitId,
  ]);
}

/** The 8-byte little-endian guid body. `CMSG_CHAR_DELETE` and `CMSG_PLAYER_LOGIN` are both just this. */
export function encodeGuidBody(guid: string): Uint8Array {
  const value = BigInt(guid);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; ++i) {
    out[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=world-wire`
Expected: PASS (10 tests)

- [ ] **Step 5: Cross-check the enum layout against the code being replaced**

Read `client/src/network/characters/handler.js` beside your `decodeCharEnum` and confirm field for field that the order and the widths match. Report what you compared.

- [ ] **Step 6: Commit**

```bash
git add client/src/network/protocol/wotlk
git commit -m "feat(protocol): add the 3.3.5 character wire codec"
```

---

### Task 4: The logon transport

**Files:**
- Create: `client/src/network/protocol/wotlk/logon.ts`
- Test: `client/src/network/protocol/wotlk/__tests__/logon.test.ts`

**Interfaces:**
- Consumes: `LOGON_OPCODE`, `encodeLogonChallenge`, `decodeLogonChallenge`, `encodeLogonProof`, `decodeLogonProof`, `encodeRealmListRequest`, `decodeRealmList` from `./logon-wire`; `logonRefusal`, `isLogonSuccess` from `../stages`; `LogonTransport`, `ProtocolRefusalError`, `RealmInfo` from `../types`; `SRP` from `../../crypto/srp`.
- Produces: `class WotlkLogonTransport implements LogonTransport`, constructed as `new WotlkLogonTransport(io, config)` where `io: LogonIo` is `{ connect(host, port): Promise<void>; send(bytes: Uint8Array): void; onMessage(listener: (bytes: Uint8Array) => void): void; close(): void }` and `config` is `{ host: string; port: number; game: string; version: [number, number, number]; build: number; platform: string; os: string; locale: string; timezone: number }`. Also `createSocketLogonIo(): LogonIo`, wrapping the existing `net/socket.js`.

The transport takes its IO as a constructor argument for one reason: it makes the whole exchange testable with a fake that replies with bytes, and no test needs a WebSocket.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=wotlk/__tests__/logon`
Expected: FAIL — cannot resolve `../logon`.

- [ ] **Step 3: Write the implementation**

Structure it as: `authenticate()` connects through the IO, sends the challenge, and returns a promise that the message listener settles. The listener dispatches on the first byte (`LOGON_OPCODE`), feeds SRP on a successful challenge, sends the proof, and resolves with `srp.K` once the server proof validates. `realms()` rejects if `authenticate()` has not resolved, otherwise sends the request and resolves with `decodeRealmList`.

```ts
/**
 * The 3.3.5 logon transport: SRP6 against realmd, then the realm list, over one socket.
 *
 * IO is injected (`LogonIo`) rather than inherited, which is what lets the whole exchange be tested
 * with a fake that replies in bytes -- no WebSocket, no server, no login. The wire layouts are in
 * `logon-wire.ts`; SRP is the existing `crypto/srp.js`, untouched.
 */
import SRP from '../../crypto/srp';
import Socket from '../../net/socket';
import { isLogonSuccess, logonRefusal } from '../stages';
import { LogonTransport, ProtocolRefusalError, RealmInfo } from '../types';
import {
  decodeLogonChallenge,
  decodeLogonProof,
  decodeRealmList,
  encodeLogonChallenge,
  encodeLogonProof,
  encodeRealmListRequest,
  LOGON_OPCODE,
} from './logon-wire';

export interface LogonIo {
  connect(host: string, port: number): Promise<void>;
  send(bytes: Uint8Array): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  close(): void;
}

export type LogonConfig = {
  host: string;
  port: number;
  game: string;
  version: [number, number, number];
  build: number;
  platform: string;
  os: string;
  locale: string;
  timezone: number;
};

export class WotlkLogonTransport implements LogonTransport {
  private readonly io: LogonIo;
  private readonly config: LogonConfig;

  private srp: any = null;
  private account = '';
  private password = '';
  private sessionKey: Uint8Array | null = null;

  private authResolve: ((value: { sessionKey: Uint8Array }) => void) | null = null;
  private authReject: ((error: Error) => void) | null = null;
  private realmsResolve: ((realms: RealmInfo[]) => void) | null = null;
  private realmsReject: ((error: Error) => void) | null = null;

  constructor(io: LogonIo, config: LogonConfig) {
    this.io = io;
    this.config = config;
    this.io.onMessage((bytes) => this.receive(bytes));
  }

  async authenticate(account: string, password: string): Promise<{ sessionKey: Uint8Array }> {
    this.account = account.toUpperCase();
    this.password = password.toUpperCase();

    await this.io.connect(this.config.host, this.config.port);

    const settled = new Promise<{ sessionKey: Uint8Array }>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });

    this.io.send(
      encodeLogonChallenge({
        account: this.account,
        game: this.config.game,
        version: this.config.version,
        build: this.config.build,
        platform: this.config.platform,
        os: this.config.os,
        locale: this.config.locale,
        timezone: this.config.timezone,
      }),
    );

    return settled;
  }

  async realms(): Promise<RealmInfo[]> {
    if (!this.sessionKey) {
      throw new Error('cannot list realms before authenticate() resolves');
    }

    const settled = new Promise<RealmInfo[]>((resolve, reject) => {
      this.realmsResolve = resolve;
      this.realmsReject = reject;
    });

    this.io.send(encodeRealmListRequest());
    return settled;
  }

  close(): void {
    this.io.close();
  }

  private receive(bytes: Uint8Array): void {
    switch (bytes[0]) {
      case LOGON_OPCODE.CHALLENGE:
        this.onChallenge(bytes);
        break;
      case LOGON_OPCODE.PROOF:
        this.onProof(bytes);
        break;
      case LOGON_OPCODE.REALM_LIST:
        this.realmsResolve?.(decodeRealmList(bytes));
        this.realmsResolve = null;
        this.realmsReject = null;
        break;
      default:
        break;
    }
  }

  private onChallenge(bytes: Uint8Array): void {
    const challenge = decodeLogonChallenge(bytes);

    if (!isLogonSuccess(challenge.code)) {
      this.failAuth(challenge.code);
      return;
    }

    this.srp = new SRP(Array.from(challenge.N!), Array.from(challenge.g!));
    this.srp.feed(
      Array.from(challenge.salt!),
      Array.from(challenge.B!),
      this.account,
      this.password,
    );

    this.io.send(
      encodeLogonProof({
        A: new Uint8Array(this.srp.A.toArray()),
        M1: new Uint8Array(this.srp.M1.digest),
      }),
    );
  }

  private onProof(bytes: Uint8Array): void {
    const proof = decodeLogonProof(bytes);

    if (!isLogonSuccess(proof.code)) {
      this.failAuth(proof.code);
      return;
    }

    if (!this.srp?.validate(Array.from(proof.M2!))) {
      // A server that answers with a proof we cannot verify is not our server.
      this.failAuth(0x0f);
      return;
    }

    this.sessionKey = new Uint8Array(this.srp.K);
    this.authResolve?.({ sessionKey: this.sessionKey });
    this.authResolve = null;
    this.authReject = null;
  }

  private failAuth(code: number): void {
    const error = new ProtocolRefusalError(logonRefusal(code));
    // Credentials are cleared here, not by the caller: a refusal must never be resubmitted (an
    // 0x05 locks the account out), and leaving them in memory invites exactly that.
    this.account = '';
    this.password = '';
    this.srp = null;
    this.authReject?.(error);
    this.authResolve = null;
    this.authReject = null;
  }
}
```

- [ ] **Step 4: Write `createSocketLogonIo`**

Append to the same file, wrapping the existing socket so production has an IO to pass:

```ts
/**
 * The production IO: the existing `net/socket.js`, which already frames realmd's self-delimiting
 * packets by handing us whatever arrived. Kept at the bottom of this file because it is the only
 * part that cannot be unit-tested, and keeping it small is what makes that acceptable.
 */
export function createSocketLogonIo(): LogonIo {
  const socket = new Socket();

  return {
    connect(host: string, port: number) {
      return new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('disconnect', () => reject(new Error('logon socket closed')));
        socket.connect(host, port);
      });
    },
    send(bytes: Uint8Array) {
      socket.socket.send(bytes);
    },
    onMessage(listener: (bytes: Uint8Array) => void) {
      socket.on('data:receive', () => {
        const available = socket.buffer.available;
        listener(new Uint8Array(socket.buffer.read(available)));
      });
    },
    close() {
      socket.disconnect();
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=wotlk/__tests__/logon`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add client/src/network/protocol/wotlk
git commit -m "feat(protocol): add the 3.3.5 logon transport over injected IO"
```

---

### Task 5: The world transport

**Files:**
- Create: `client/src/network/protocol/wotlk/world.ts`
- Test: `client/src/network/protocol/wotlk/__tests__/world.test.ts`

**Interfaces:**
- Consumes: the codecs from `./world-wire`; `worldRefusal`, `isWorldSuccess` from `../stages`; `WorldTransport`, `CharacterRecord`, `CharCreateRequest`, `ProtocolRefusalError`, `RealmInfo` from `../types`.
- Produces: `class WotlkWorldTransport implements WorldTransport`, constructed as `new WotlkWorldTransport(io, proxy)` where `proxy: ProxyConfig` comes from `../endpoint` where `handler: WorldPacketIo` is `{ connect(host, port, realm): Promise<void>; send(opcode: number, body: Uint8Array): void; on(opcodeName: string, listener: (body: Uint8Array) => void): void; onDisconnect(listener: (reason: string) => void): void; close(): void }`, plus `createGameHandlerIo(session): WorldPacketIo`.

**Deliberate deviation from the spec, stated out loud.** Spec §3.5 has the handshake MOVING out of `game/handler.js`. It does not move here. `GameHandler` owns the socket, the RC4 header crypt, the packet framing AND all in-world gameplay on the same connection; relocating the handshake risks the working world path for no gain that spec 3 needs. Instead `WotlkWorldTransport` DRIVES the existing handler through the narrow `WorldPacketIo` seam above, and `game/handler.js` is not edited at all. What spec 3 needs is the typed interface, and it gets exactly that. Record this in your report; the relocation stays available later, on its own, with the world route as its test.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=wotlk/__tests__/world`
Expected: FAIL — cannot resolve `../world`.

- [ ] **Step 3: Write the implementation**

One promise per outstanding request, settled by the matching `SMSG_*` listener. Opcode numbers come from the existing `game/opcode.js` (`CMSG_CHAR_ENUM = 0x037`, `CMSG_CHAR_CREATE = 0x036`, `CMSG_CHAR_DELETE = 0x038`, `CMSG_PLAYER_LOGIN = 0x03d`) — import that table, do not retype the numbers.

```ts
/**
 * The 3.3.5 world transport: the character roster, create, delete, and entering the world.
 *
 * It DRIVES the existing `network/game/handler.js` through a narrow seam rather than replacing it.
 * That handler owns the socket, the RC4 header crypt, the packet framing and every in-world gameplay
 * handler on the same connection; moving the handshake out of it would risk the working world path
 * for nothing spec 3 needs. What spec 3 needs is this typed surface.
 */
import GameOpcode from '../../game/opcode';
import GamePacket from '../../game/packet';
import { ProxyConfig, resolveRealmEndpoint } from '../endpoint';
import { isWorldSuccess, worldRefusal } from '../stages';
import {
  CharacterRecord,
  CharCreateRequest,
  ProtocolRefusalError,
  RealmInfo,
  WorldTransport,
} from '../types';
import {
  CHAR_RESULT,
  charCreateRefusal,
  charDeleteRefusal,
  decodeCharEnum,
  decodeResultByte,
  encodeCharCreateBody,
  encodeGuidBody,
} from './world-wire';

export interface WorldPacketIo {
  connect(host: string, port: number, realm: RealmInfo): Promise<void>;
  send(opcode: number, body: Uint8Array): void;
  on(opcodeName: string, listener: (body: Uint8Array) => void): void;
  onDisconnect(listener: (reason: string) => void): void;
  close(): void;
}

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

export class WotlkWorldTransport implements WorldTransport {
  private readonly io: WorldPacketIo;
  private readonly proxy: ProxyConfig;

  private join_: Pending<void> | null = null;
  private roster: Pending<CharacterRecord[]> | null = null;
  private create: Pending<void> | null = null;
  private remove: Pending<void> | null = null;
  private enter: Pending<void> | null = null;

  constructor(io: WorldPacketIo, proxy: ProxyConfig) {
    this.io = io;
    this.proxy = proxy;

    this.io.on('SMSG_AUTH_RESPONSE', (body) => {
      const code = decodeResultByte(body);
      if (isWorldSuccess(code)) {
        this.settle(this.join_, undefined);
      } else {
        this.fail(this.join_, new ProtocolRefusalError(worldRefusal(code)));
      }
      this.join_ = null;
    });

    this.io.on('SMSG_CHAR_ENUM', (body) => {
      this.settle(this.roster, decodeCharEnum(body));
      this.roster = null;
    });

    this.io.on('SMSG_CHAR_CREATE', (body) => {
      const code = decodeResultByte(body);
      if (code === CHAR_RESULT.CREATE_SUCCESS) {
        this.settle(this.create, undefined);
      } else {
        this.fail(this.create, new ProtocolRefusalError(charCreateRefusal(code)));
      }
      this.create = null;
    });

    this.io.on('SMSG_CHAR_DELETE', (body) => {
      const code = decodeResultByte(body);
      if (code === CHAR_RESULT.DELETE_SUCCESS) {
        this.settle(this.remove, undefined);
      } else {
        this.fail(this.remove, new ProtocolRefusalError(charDeleteRefusal(code)));
      }
      this.remove = null;
    });

    this.io.on('SMSG_LOGIN_VERIFY_WORLD', () => {
      this.settle(this.enter, undefined);
      this.enter = null;
    });
  }

  join(realm: RealmInfo, _account: string, _sessionKey: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.join_ = { resolve, reject };
      // Through the endpoint policy, never the realm's advertised address: from a browser the game
      // server is reachable only via the websockify proxy (`endpoint.ts` explains why). The handshake
      // itself belongs to the handler, which already holds the account and session key it needs;
      // connecting is what starts it.
      const endpoint = resolveRealmEndpoint(realm, this.proxy);
      this.io.connect(endpoint.host, endpoint.port, realm).catch(reject);
    });
  }

  characters(): Promise<CharacterRecord[]> {
    return new Promise<CharacterRecord[]>((resolve, reject) => {
      this.roster = { resolve, reject };
      this.io.send(GameOpcode.CMSG_CHAR_ENUM, new Uint8Array(0));
    });
  }

  createCharacter(request: CharCreateRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.create = { resolve, reject };
      this.io.send(GameOpcode.CMSG_CHAR_CREATE, encodeCharCreateBody(request));
    });
  }

  deleteCharacter(guid: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.remove = { resolve, reject };
      this.io.send(GameOpcode.CMSG_CHAR_DELETE, encodeGuidBody(guid));
    });
  }

  enterWorld(guid: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.enter = { resolve, reject };
      this.io.send(GameOpcode.CMSG_PLAYER_LOGIN, encodeGuidBody(guid));
    });
  }

  close(): void {
    this.io.close();
  }

  onDisconnect(listener: (reason: string) => void): void {
    this.io.onDisconnect(listener);
  }

  private settle<T>(pending: Pending<T> | null, value: T): void {
    pending?.resolve(value);
  }

  private fail<T>(pending: Pending<T> | null, error: Error): void {
    pending?.reject(error);
  }
}
```

- [ ] **Step 4: Write `createGameHandlerIo`**

Append to the same file. It adapts the existing handler: `send` builds a `GamePacket` with the opcode and appends the body; `on` subscribes to the handler's existing `packet:receive:<NAME>` events and hands the listener the packet's remaining bytes.

```ts
/**
 * Adapts the existing `GameHandler` to `WorldPacketIo`. The handler stays exactly as it is -- this
 * is the whole of the coupling, and it is deliberately this small.
 */
export function createGameHandlerIo(handler: any): WorldPacketIo {
  return {
    connect(host: string, port: number, realm: RealmInfo) {
      return new Promise<void>((resolve, reject) => {
        handler.once('authenticate', () => resolve());
        handler.once('reject', () =>
          // Name the endpoint. A realm on a port no websockify process is listening on fails right
          // here, and the word "refused" on its own sends the reader looking in the wrong place.
          reject(new Error(`world handshake refused at ${host}:${port}`)),
        );
        // The handler takes (host, realm) and reads the port off the realm, so it must be handed the
        // POLICY's host and port -- not the realm's advertised address.
        handler.connect(host, { ...realm, port });
      });
    },
    send(opcode: number, body: Uint8Array) {
      const packet = new GamePacket(opcode, GamePacket.HEADER_SIZE_OUTGOING + body.length);
      if (body.length) {
        packet.write(Array.from(body));
      }
      handler.send(packet);
    },
    on(opcodeName: string, listener: (body: Uint8Array) => void) {
      handler.on(`packet:receive:${opcodeName}`, (packet: any) => {
        listener(new Uint8Array(packet.read(packet.available)));
      });
    },
    onDisconnect(listener: (reason: string) => void) {
      handler.on('disconnect', () => listener('socket closed'));
    },
    close() {
      handler.disconnect();
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=wotlk/__tests__/world`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add client/src/network/protocol/wotlk
git commit -m "feat(protocol): add the 3.3.5 world transport over the existing handler"
```

---

### Task 6: The session state machine

**Files:**
- Create: `client/src/network/protocol/session.ts`
- Test: `client/src/network/protocol/__tests__/session.test.ts`

**Interfaces:**
- Consumes: `LoginStage` from `./stages`; `LogonTransport`, `WorldTransport`, `RealmInfo`, `CharacterRecord`, `CharCreateRequest`, `ProtocolRefusalError` from `./types`.
- Produces: `class ProtocolSession` with `constructor(logon: LogonTransport, world: WorldTransport, options?: { retryDelayMs?: number })`, `get stage(): LoginStage`, `get realms(): RealmInfo[]`, `get characters(): CharacterRecord[]`, `get lastRefusal(): ProtocolRefusal | null`, `login(account, password): Promise<void>`, `chooseRealm(realm): Promise<void>`, `createCharacter(request): Promise<void>`, `deleteCharacter(guid): Promise<void>`, `enterWorld(guid): Promise<void>`, `on(listener: (state: SessionState) => void): () => void`, where `SessionState = { stage: LoginStage; realms: RealmInfo[]; characters: CharacterRecord[]; refusal: ProtocolRefusal | null }`. `RETRY_DELAY_MS = 3000`.

- [ ] **Step 1: Write the failing test**

```ts
import { ProtocolSession, RETRY_DELAY_MS } from '../session';
import { LoginStage } from '../stages';
import { ProtocolRefusalError } from '../types';

function fakeLogon() {
  return {
    authenticate: jest.fn(async () => ({ sessionKey: new Uint8Array(40) })),
    realms: jest.fn(async () => [
      {
        id: 1,
        name: 'Test',
        host: 'realm.example.com',
        port: 8085,
        population: 1,
        characterCount: 0,
        online: true,
        recommended: false,
        pvp: false,
      },
    ]),
    close: jest.fn(),
  };
}

function fakeWorld() {
  return {
    join: jest.fn(async () => undefined),
    characters: jest.fn(async () => []),
    createCharacter: jest.fn(async () => undefined),
    deleteCharacter: jest.fn(async () => undefined),
    enterWorld: jest.fn(async () => undefined),
    close: jest.fn(),
    onDisconnect: jest.fn(),
  };
}

describe('ProtocolSession', () => {
  it('starts offline', () => {
    expect(new ProtocolSession(fakeLogon(), fakeWorld()).stage).toBe(LoginStage.Offline);
  });

  it('walks the stages in order on a clean login', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    const seen: LoginStage[] = [];
    session.on((state) => seen.push(state.stage));

    await session.login('tester', 'secret');

    expect(seen).toEqual([
      LoginStage.Connecting,
      LoginStage.Authenticating,
      LoginStage.RealmList,
    ]);
    expect(session.realms).toHaveLength(1);
  });

  it('reaches the character list once a realm is chosen', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    await session.login('tester', 'secret');

    await session.chooseRealm(session.realms[0]);

    expect(session.stage).toBe(LoginStage.CharacterList);
  });

  it('reaches the world', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);

    await session.enterWorld('0x1');

    expect(session.stage).toBe(LoginStage.InWorld);
    expect(world.enterWorld).toHaveBeenCalledWith('0x1');
  });

  it('refreshes the roster after a create and after a delete', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);

    await session.createCharacter({
      name: 'Newbie',
      race: 1,
      class: 1,
      gender: 0,
      appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
      outfitId: 0,
    });
    await session.deleteCharacter('0x1');

    // Once on entering the list, once per mutation: the roster is never guessed at locally.
    expect(world.characters).toHaveBeenCalledTimes(3);
  });

  it('keeps the refusal and goes back offline when the server refuses', async () => {
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValue(
      new ProtocolRefusalError({ code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' }),
    );
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'wrong')).rejects.toBeInstanceOf(ProtocolRefusalError);

    expect(session.stage).toBe(LoginStage.Offline);
    expect(session.lastRefusal).toEqual({ code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' });
  });

  it('NEVER resubmits after a refusal, however long you wait', async () => {
    jest.useFakeTimers();
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValue(
      new ProtocolRefusalError({ code: 0x05, stringKey: 'AUTH_INCORRECT_PASSWORD' }),
    );
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'wrong')).rejects.toBeInstanceOf(ProtocolRefusalError);
    jest.advanceTimersByTime(RETRY_DELAY_MS * 10);
    await Promise.resolve();

    // One attempt, ever. On vmangos an 0x05 locks the account out; a retry loop is how that happens.
    expect(logon.authenticate).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('retries a TRANSPORT failure once per retry delay while credentials stand', async () => {
    jest.useFakeTimers();
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValueOnce(new Error('socket closed'));
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'secret')).rejects.toThrow(/socket closed/);
    expect(logon.authenticate).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(RETRY_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(logon.authenticate).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('hands every listener the same state object shape', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    const states: any[] = [];
    const unsubscribe = session.on((state) => states.push(state));

    await session.login('tester', 'secret');
    unsubscribe();
    await session.chooseRealm(session.realms[0]);

    expect(Object.keys(states[0]).sort()).toEqual(['characters', 'realms', 'refusal', 'stage']);
    // Unsubscribed: nothing after the realm choice.
    expect(states.some((state) => state.stage === LoginStage.CharacterList)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=protocol/__tests__/session`
Expected: FAIL — cannot resolve `../session`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The pre-world session: the one place that knows what order the exchanges happen in.
 *
 * Version-neutral by construction -- it imports the two transport INTERFACES and nothing under
 * `wotlk/`. Screens read `stage`, `realms`, `characters` and `refusal` from state rather than
 * accumulating them from string events, which is what the old handler-per-exchange design forced.
 *
 * The policy is the reference's (benilla `login/mod.rs`), not invented here:
 *  - a REFUSAL clears the credentials and stops. No retry against a wrong password: on vmangos an
 *    0x05 locks the account out, which is exactly why the server answers unknown-account and
 *    wrong-password with the same 0x04.
 *  - a TRANSPORT failure with credentials still standing retries on a flat 3 s beat.
 */
import { LoginStage } from './stages';
import {
  CharacterRecord,
  CharCreateRequest,
  LogonTransport,
  ProtocolRefusal,
  ProtocolRefusalError,
  RealmInfo,
  WorldTransport,
} from './types';

/** The reference's flat reconnect beat. */
export const RETRY_DELAY_MS = 3000;

export type SessionState = {
  stage: LoginStage;
  realms: RealmInfo[];
  characters: CharacterRecord[];
  refusal: ProtocolRefusal | null;
};

export class ProtocolSession {
  private readonly logon: LogonTransport;
  private readonly world: WorldTransport;
  private readonly retryDelayMs: number;

  private stage_: LoginStage = LoginStage.Offline;
  private realms_: RealmInfo[] = [];
  private characters_: CharacterRecord[] = [];
  private refusal_: ProtocolRefusal | null = null;

  private credentials: { account: string; password: string } | null = null;
  private sessionKey: Uint8Array | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(state: SessionState) => void>();

  constructor(
    logon: LogonTransport,
    world: WorldTransport,
    options: { retryDelayMs?: number } = {},
  ) {
    this.logon = logon;
    this.world = world;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  get stage(): LoginStage {
    return this.stage_;
  }

  get realms(): RealmInfo[] {
    return this.realms_;
  }

  get characters(): CharacterRecord[] {
    return this.characters_;
  }

  get lastRefusal(): ProtocolRefusal | null {
    return this.refusal_;
  }

  /** Subscribe to state; returns the unsubscribe. */
  on(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async login(account: string, password: string): Promise<void> {
    this.credentials = { account, password };
    this.refusal_ = null;
    return this.attemptLogin();
  }

  async chooseRealm(realm: RealmInfo): Promise<void> {
    if (!this.sessionKey || !this.credentials) {
      throw new Error('cannot choose a realm before logging in');
    }

    this.enter(LoginStage.JoiningRealm);
    await this.world.join(realm, this.credentials.account, this.sessionKey);
    await this.refreshCharacters();
  }

  async createCharacter(request: CharCreateRequest): Promise<void> {
    await this.world.createCharacter(request);
    await this.refreshCharacters();
  }

  async deleteCharacter(guid: string): Promise<void> {
    await this.world.deleteCharacter(guid);
    await this.refreshCharacters();
  }

  async enterWorld(guid: string): Promise<void> {
    this.enter(LoginStage.EnteringWorld);
    await this.world.enterWorld(guid);
    this.enter(LoginStage.InWorld);
  }

  private async attemptLogin(): Promise<void> {
    const credentials = this.credentials;
    if (!credentials) {
      throw new Error('no credentials to log in with');
    }

    this.enter(LoginStage.Connecting);

    try {
      this.enter(LoginStage.Authenticating);
      const { sessionKey } = await this.logon.authenticate(
        credentials.account,
        credentials.password,
      );
      this.sessionKey = sessionKey;

      this.realms_ = await this.logon.realms();
      this.enter(LoginStage.RealmList);
    } catch (error) {
      this.onLoginFailure(error);
      throw error;
    }
  }

  /**
   * A refusal is final; a transport failure is not. The difference is the whole policy: one of them
   * can lock an account out if retried, and the other only means the network blinked.
   */
  private onLoginFailure(error: unknown): void {
    this.stage_ = LoginStage.Offline;

    if (error instanceof ProtocolRefusalError) {
      this.refusal_ = error.refusal;
      this.credentials = null;
      this.notify();
      return;
    }

    this.notify();

    if (this.credentials && this.retryTimer === null) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        // Fire and forget: a failed retry schedules the next one through this same path.
        void this.attemptLogin().catch(() => undefined);
      }, this.retryDelayMs);
    }
  }

  private async refreshCharacters(): Promise<void> {
    this.characters_ = await this.world.characters();
    this.enter(LoginStage.CharacterList);
  }

  private enter(stage: LoginStage): void {
    this.stage_ = stage;
    this.notify();
  }

  private notify(): void {
    const state: SessionState = {
      stage: this.stage_,
      realms: this.realms_,
      characters: this.characters_,
      refusal: this.refusal_,
    };
    this.listeners.forEach((listener) => listener(state));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=protocol/__tests__/session`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/network/protocol
git commit -m "feat(protocol): add the pre-world session state machine"
```

---

### Task 7: Expose the session, break nothing

**Files:**
- Modify: `client/src/network/session.ts`
- Modify: `client/src/game/ui/screens.ts` (the `GlueContext` type only)
- Test: `client/src/network/__tests__/protocol-wiring.test.ts`

**Interfaces:**
- Consumes: `ProtocolSession` from `./protocol/session`; `WotlkLogonTransport`, `createSocketLogonIo` from `./protocol/wotlk/logon`; `WotlkWorldTransport`, `createGameHandlerIo` from `./protocol/wotlk/world`.
- Produces: `GameSession#protocol: ProtocolSession`, built lazily; `GlueContext.protocol: ProtocolSession` alongside the existing `session`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=protocol-wiring`
Expected: FAIL — `session.protocol` is undefined.

- [ ] **Step 3: Add the lazy accessor to `GameSession`**

In `client/src/network/session.ts`, add the import and a lazily-built accessor. Lazy matters: building the transports must not connect anything, and the offline route must stay socket-free.

```ts
  private protocol_: ProtocolSession | null = null;

  /**
   * The typed pre-world session. Built on first read, and building it opens nothing -- the transports
   * connect only when `login()` is called. The legacy handlers above stay exactly where they are
   * until spec 3's screens replace them.
   */
  get protocol(): ProtocolSession {
    if (!this.protocol_) {
      this.protocol_ = new ProtocolSession(
        new WotlkLogonTransport(createSocketLogonIo(), {
          host: config.serverhost,
          port: Number(config.authport),
          game: config.game,
          version: [config.majorVersion, config.minorVersion, config.patchVersion],
          build: config.build,
          platform: config.platform,
          os: config.os,
          locale: config.locale,
          timezone: config.timezone,
        }),
        new WotlkWorldTransport(createGameHandlerIo(this.game), {
          // The websockify proxies listen on the host the app was served from; the realm's own
          // advertised address has no WebSocket listener. See `protocol/endpoint.ts`.
          proxyHost: config.serverhost,
          rewriteRealmHost: true,
        }),
      );
    }
    return this.protocol_;
  }
```

- [ ] **Step 4: Add `protocol` to `GlueContext`**

In `client/src/game/ui/screens.ts`, extend the context type and populate it in `enter()`:

```ts
  /** The typed pre-world session (spec 2). The login screen (spec 3) is its first consumer. */
  protocol: ProtocolSession;
```

```ts
      protocol: this.session.protocol,
```

- [ ] **Step 5: Run the tests**

Run: `cd client && npm test -- --watchAll=false --testPathPattern="protocol|ui/|offline-session"`
Expected: PASS, including the offline-session suite proving no socket opens.

- [ ] **Step 6: Verify the existing routes by hand**

Run the dev server with a bounded polling loop over its log (no monitors), then confirm 200 from `/`, `/realms`, `/characters`, `/glue`, `/game?offline=1`, and confirm the dev-server log carries no new compile error. Kill the server. Report the actual output. If a browser is available to you, also confirm `/glue` still renders the login stage — the screens must be untouched by this task.

- [ ] **Step 7: Commit**

```bash
git add client/src/network client/src/game/ui/screens.ts
git commit -m "feat(protocol): expose the typed session without disturbing the old path"
```

---

## Done criteria

- `cd client && npm test -- --watchAll=false` passes, including the five new protocol suites.
- `session.protocol` walks Offline → RealmList → CharacterList → InWorld against fake transports, refuses to retry a refusal, and retries a transport failure on the 3 s beat.
- `/`, `/realms`, `/characters`, `/glue` and `/game?offline=1` behave exactly as before; no socket opens from constructing anything.
- The provisional `CHAR_CREATE_*`/`CHAR_DELETE_*` codes are isolated in `world-wire.ts` and labelled as provisional, with the live-server check named as the thing that confirms them.
