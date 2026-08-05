# Protocol Layer — Design

**Date:** 2026-08-05
**Status:** Design proposed, awaiting approval
**Scope:** Spec 2 of the glue program. The pre-world session: logon, realm list, the world handshake,
the character roster and character create/delete — behind a version-neutral interface with one
implementation (3.3.5a, build 12340), shaped so a 1.12.1 implementation can land beside it.

---

## 1. Problem

The pre-world networking works but has no shape a screen can build on.

**It talks in strings.** Every handler is an `EventEmitter` and every screen listens for names:
`session.auth.on('authenticate')`, `session.realms.on('refresh')`, `session.characters.on('refresh')`,
`session.game.on('join')`. A screen cannot know what a payload contains, a typo in an event name fails
silently, and nothing describes the order the exchanges must happen in.

**It reports failure by alerting the user.** [`auth/handler.js`](../../../client/src/network/auth/handler.js)
calls `alert("Invalid Account!")` from inside a packet handler, twice, and emits a bare `reject` with
no code. The server's actual result byte — the thing that decides which of the client's own `AUTH_*`
strings to show — is read and thrown away.

**It cannot create or delete a character.** [`characters/handler.js`](../../../client/src/network/characters/handler.js)
sends `CMSG_CHAR_ENUM` and parses the roster; there is no `CMSG_CHAR_CREATE`, no `CMSG_CHAR_DELETE`,
and no handler for `SMSG_CHAR_CREATE`/`SMSG_CHAR_DELETE` — even though
[`game/opcode.js`](../../../client/src/network/game/opcode.js) already declares all six (`0x036`–`0x03C`)
along with the whole 3.3.5 table. `/create-character` in [`app.tsx`](../../../client/src/app.tsx)
renders the string `create character`.

**There is nothing a second version could plug into.** The wire details are spread across the
handlers: `config.build`, the logon challenge body, the char-enum field order, the world handshake.
A 1.12.1 implementation today would mean editing those files in place.

What already works and must be kept: SRP6 ([`crypto/srp.js`](../../../client/src/network/crypto/srp.js)),
the WotLK header crypt — RC4 seeded with the two published HMAC keys
([`crypto/crypt.js`](../../../client/src/network/crypto/crypt.js)) — the byte-level packet readers,
and the opcode table. This spec re-shapes what surrounds them; it does not re-derive them.

## 2. Scope boundary

**In:** everything from "the player typed an account name" to "the world says we are in": logon
challenge/proof, realm list, world handshake, char enum, char create, char delete, and the session
state machine that sequences them, with typed results and the client's own error strings.

**Out:** in-world gameplay. [`game/handler.js`](../../../client/src/network/game/handler.js) also
carries chat, object updates, movement and the ping loop; those stay exactly where they are and keep
working through the same socket. This spec carves the *session* out of that file and leaves gameplay
untouched — otherwise it stops being a protocol layer and becomes a rewrite of the client.

Also out: the login/realm/character screens themselves (specs 3–5 and 7), and anything vanilla —
this spec ships **one** implementation and only proves the seam is real by keeping 3.3.5 specifics out
of the shared types.

## 3. Architecture

```
client/src/network/protocol/
  types.ts          version-neutral types and the two transport interfaces
  stages.ts         pure: LoginStage, result-code -> glue string key      <- unit-tested
  endpoint.ts       pure: which host/port a browser may actually dial     <- unit-tested
  session.ts        the state machine: park model, typed events, policy   <- unit-tested
  wotlk/
    logon-wire.ts   pure: challenge / proof / realm-list byte layouts     <- unit-tested
    logon.ts        the exchange, over injected IO                        <- unit-tested
    world-wire.ts   pure: char enum / create / delete byte layouts        <- unit-tested
    world.ts        drives the existing game handler                      <- unit-tested
```

`crypto/`, `net/` (socket, byte buffers) and `game/opcode.js` stay where they are and are used by
`wotlk/`. `session.ts` never imports anything under `wotlk/`; it is handed transports.

### 3.1 The version-neutral types

The seam is only real if a 1.12 implementation can satisfy these without the types bending. Three
places where 3.3.5 differs and the types must therefore stay quiet about it:

- **Logon protocol version** (8 in WotLK, 3 in vanilla) and the challenge body layout — entirely
  inside `wotlk/logon.ts`.
- **Character roster fields.** Equipment is a *list*, not 23 fixed slots: vanilla enumerates 19 plus a
  bag, WotLK 23. A `CharacterRecord` carries `equipment: EquipmentDisplay[]`, and the booth (spec 6)
  reads what is there.
- **The world handshake.** WotLK sends an addon block and a different digest input than vanilla; both
  live in `wotlk/world.ts` behind `WorldTransport#handshake`.

```ts
export type RealmInfo = {
  id: number; name: string;
  /** Host as the realm advertises it, without the port. What we actually dial is section 3.1a. */
  host: string; port: number;
  population: number; characterCount: number;
  online: boolean; recommended: boolean; pvp: boolean;
  /** Present only when the realm advertises a build; absent is not an error. */
  build?: { major: number; minor: number; patch: number; build: number };
};

export type EquipmentDisplay = { displayId: number; inventoryType: number; enchantmentId: number };

export type CharacterRecord = {
  guid: string; name: string;
  race: number; class: number; gender: number; level: number;
  /** Skin, face, hair style, hair colour, facial hair -- the five dials spec 7 edits. */
  appearance: { skin: number; face: number; hairStyle: number; hairColor: number; facialHair: number };
  zoneId: number; mapId: number; position: [number, number, number];
  guildId: number; flags: number;
  equipment: EquipmentDisplay[];
  pet?: { displayId: number; level: number; family: number };
};

export type CharCreateRequest = {
  name: string; race: number; class: number; gender: number;
  appearance: CharacterRecord['appearance']; outfitId: number;
};

/** A refusal from the server, typed so the UI can name it in the client's own words. */
export type ProtocolRefusal = { code: number; stringKey: string };
```

### 3.1a Where the browser can actually connect

A browser cannot open a raw TCP socket, so every connection goes through the WebSocket-to-TCP proxy
in `client/websockify.js` -- one process per (listen port to target host:port), started by hand
(`npm run proxy1`, `proxy2`). Two consequences the layer must state rather than assume:

- **The realm list advertises the SERVER's address**, e.g. `95.181.139.52:8086`. Nothing is listening
  for WebSockets there. The existing client survives this by connecting to the *proxy* host with the
  *realm's* port (`realms.tsx` passes `session.auth.host` along with the realm) -- an unwritten
  convention that everything silently depends on.
- So the layer carries one pure policy, `resolveRealmEndpoint(realm, config)`: by default keep the
  realm's port and substitute the configured proxy host, with an explicit override for a deployment
  that terminates WebSockets at the realm itself. It is tested, and it is the only place that knows
  the browser is not talking to the game server directly.

A realm on a port no proxy listens on therefore cannot be reached, and today it fails silently. The
layer cannot fix that from inside a browser; what it can do is name the endpoint it tried in the
failure, so the cause is visible instead of mysterious.

### 3.2 The two transports

```ts
export interface LogonTransport {
  /** Opens the socket and runs challenge + proof. Rejects with a ProtocolRefusal on a refusal. */
  authenticate(account: string, password: string): Promise<{ sessionKey: Uint8Array }>;
  realms(): Promise<RealmInfo[]>;
  close(): void;
}

export interface WorldTransport {
  /** Handshake against a realm with the logon session key. */
  join(realm: RealmInfo, account: string, sessionKey: Uint8Array): Promise<void>;
  characters(): Promise<CharacterRecord[]>;
  createCharacter(request: CharCreateRequest): Promise<void>;
  deleteCharacter(guid: string): Promise<void>;
  /** Resolves when the world confirms the login. */
  enterWorld(guid: string): Promise<void>;
  close(): void;
  /** The socket died; the session's reconnect policy reads this. */
  onDisconnect(listener: (reason: string) => void): void;
}
```

Every rejection is a `ProtocolRefusal` or an `Error` with a cause — never a bare emit, never an
`alert`.

### 3.3 The session state machine

`session.ts` owns the sequence and nothing else. It mirrors the reference's park model
(benilla `net.rs`, `login/mod.rs`): the session waits at a stage until the thing it needs arrives.

```
Offline -> Connecting -> Authenticating -> RealmList -> JoiningRealm -> CharacterList -> EnteringWorld -> InWorld
```

Each stage transition is an event carrying data (`{ stage: LoginStage, realms?, characters? }`), so a
screen renders from state rather than accumulating it from string events.

Policy, ported from the reference rather than invented:

- **A refusal clears the pending credentials and stops.** No automatic retry against a "wrong
  password" — that is how an account gets locked out.
- **A transport failure with credentials still pending retries once every 3 s**, flat, as
  `login/mod.rs` does. The retry is at the session level; nothing sleeps inside a transport.
- **Both codes for a bad account are the same byte.** vmangos answers unknown-account *and*
  wrong-password with `0x04`, because `0x05` triggers a client-side lockout. So the UI shows the
  string for the code the server actually sent; it never guesses which of the two happened.

### 3.4 Error codes to the client's own words

`stages.ts` maps a result byte to a `GlueStrings` key — `0x04` → `AUTH_UNKNOWN_ACCOUNT`, `0x03` →
`AUTH_ACCOUNT_BANNED`, char-create's `CHAR_CREATE_*`, char-delete's `CHAR_DELETE_*`. Pure, table-driven,
tested. The mapping lives here rather than in a screen because two screens need the same table, and
because an unmapped code must fall back to something visible rather than to a blank dialog.

### 3.5 What happens to the existing files

- `auth/handler.js` → `wotlk/logon.ts`. Same SRP calls, same packet writes; the `alert`s and the bare
  `reject` emits go away, replaced by typed rejections.
- `realms/handler.js` → folded into `wotlk/logon.ts` (`realms()`), since it speaks over the same socket
  and only exists as a separate object because of the emitter style.
- `characters/handler.js` → `wotlk/world.ts`, joined by create and delete.
- `game/handler.js` → **not edited at all.** It owns the socket, the RC4 header crypt, the packet
  framing and every in-world gameplay handler on one connection, so relocating the handshake out of it
  risks the working world path for nothing the login screen needs. `wotlk/world.ts` instead DRIVES it
  through a narrow packet-IO seam (`connect`, `send(opcode, body)`, `on(opcodeName)`, `onDisconnect`,
  `close`). What spec 3 needs is the typed surface, and it gets exactly that; the relocation stays
  available later as its own change, with the world route as its test.
- The old `auth`/`realms`/`characters` handlers keep working the whole time rather than being deleted
  as each transport lands, so `/`, `/realms` and `/characters` never break mid-plan. Spec 3 removes
  them together with the screens that use them.
- `session.ts` (the existing one) becomes the new machine; `GameSession`'s public surface keeps
  `player`, and the `offline`/`offlineSpot` flags spec 1 added stay untouched.

## 4. Testing

Pure and offline, in the style the parser tests already use — hand-built buffers, no live server:

1. `stages.ts` — every mapped result code, and the fallback for an unmapped one.
2. `wotlk/logon.ts` — encode a logon challenge and assert the bytes (game name, build, locale, the
   reversed platform/OS tags, account length); decode a challenge response and a proof; decode a realm
   list including a realm that advertises a build and one that does not.
3. `wotlk/world.ts` — decode a char-enum with two characters (one with a pet, one without, and
   different equipment counts); encode a char-create; decode both `SMSG_CHAR_CREATE` success and
   refusal.
4. `session.ts` — against fake transports: the happy sequence emits the stages in order; a refusal
   clears credentials and does not retry; a transport failure with pending credentials retries once
   after the 3 s pacing (fake timers).

Plus one manual check that costs nothing to state and everything to skip: the existing world route
still reaches the world after the handshake moves. `/game?offline=1` covers the offline path; a live
server covers the online one when one is available.

## 5. Out of scope

Screens (specs 3–5, 7), character appearance (spec 6), in-world gameplay opcodes, sound, and the
vanilla implementation. Reconnect beyond the flat 3 s resubmit, queue position handling, and the
`SMSG_TRANSFER_PENDING` world-transfer flow are all deliberately deferred — none of them is on the
path from the login screen to a character standing in the world.
