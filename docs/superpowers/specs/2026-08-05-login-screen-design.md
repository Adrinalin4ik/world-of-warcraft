# Login Screen — Design

**Date:** 2026-08-05
**Status:** Design proposed, awaiting approval
**Scope:** Spec 3 of the glue program. The real `AccountLogin` screen, transcribed from the client's own
GlueXML, wired to the typed session from spec 2 — and the retirement of the placeholder React screens
it replaces.

---

## 1. What exists and what this replaces

Spec 1 built the widget layer and the 3D glue scene; `/glue` currently shows a throwaway probe screen
(a logo, one button, an edit box, a dialog) over the real `UI_MainMenu_Northrend` stage. Spec 2 built
the typed session: `ProtocolSession` with stages `Offline → Connecting → Authenticating → RealmList →
JoiningRealm → CharacterList → EnteringWorld → InWorld`, refusals carrying the client's own `AUTH_*`
string keys, and `connection-settings.ts` holding the server address as data. Nothing reads those
settings yet, and nothing in the UI reaches `session.protocol`. This spec is where all three meet.

It also retires [`pages/auth/auth.tsx`](../../../client/src/pages/auth/auth.tsx),
[`pages/realms/realms.tsx`](../../../client/src/pages/realms/realms.tsx) and
[`pages/characters/index.tsx`](../../../client/src/pages/characters/index.tsx) — the HTML forms that
have stood in for these screens.

**Retiring them is a prerequisite, not a tidy-up.** Spec 2's world handshake reaches the account and
session key by writing a stand-in `{ K }` onto `session.auth.srp`, because `AuthHandler.key` is a
getter with no setter. That is the same `AuthHandler` singleton the legacy screens drive. While both
paths exist, one `GameSession` can hold a real `SRP` for one and a stand-in for the other. So the old
screens come out in this spec, before the new screen is wired — which closes that window rather than
widening it.

## 2. Scope

**In — the authored screen's functional core**, as the client draws it:

- The `UI_MainMenu` stage behind it, chosen the way `accountlogin.lua:32-37` chooses: the Wrath
  causeway normally, the vanilla arch for a streaming-trial account. The URL override spec 1 added
  stays for debugging.
- The WoW logo (256×128, `TOP` at y=10), the account box (600×64, `BOTTOM` at y=345), the password box
  (256×64, `BOTTOM` at y=275), the Login button (`BOTTOM` at y=170), the Save Account Name check
  button (20×20) with its label, the version block, and the Blizzard logo — all at their authored
  coordinates and with the client's own art and strings.
- Password masking (the widget layer already has it), `letters="16"` caps, Tab between the boxes, Enter
  to submit, Escape to clear.
- The connecting dialog and the error dialog, the latter showing the string the server's own result
  code names — `AUTH_UNKNOWN_ACCOUNT`, `AUTH_INCORRECT_PASSWORD`, `AUTH_BANNED` and the rest.
- Saved account name, persisted locally, restored on the next visit — the checkbox's actual purpose.
- **One addition that is ours, not the client's:** a server address field. The real client reads
  `realmlist.wtf`; this one is meant for any private server, so the address has to be reachable from
  the screen. It is drawn in the authored idiom but it is not authored — the spec says so out loud so
  nobody later mistakes it for reference fidelity.

**Out:** everything the reference screen carries that does not serve logging in — Credits,
Cinematics, TOS and EULA, the survey, the token/authenticator flow, Manage/Upgrade Account, the
Community button, the launcher toggle and the account drop-down. benilla cut the same set for the same
reason. Also out: the realm-list screen (spec 4), character select (spec 5), appearance (spec 6) and
character create (spec 7).

## 3. Architecture

```
client/src/game/ui/screens/
  login.ts          the authored layout, transcribed from AccountLogin.xml
  login-state.ts    pure: which dialog a stage/refusal implies       <- unit-tested
  realm-stub.ts     a minimal realm picker until spec 4
  character-stub.ts a minimal character picker until spec 5
```

`screens/probe.ts` and `PROBE_ART` are deleted. `login.ts` registers for `ClientState.Login`; the two
stubs register for `RealmList` and `CharSelect` so the machine's transitions land somewhere real.

### 3.1 What the screen does, and what it refuses to do

The screen owns layout and input. It reads `ctx.protocol` for state and calls three methods on it —
`login`, `chooseRealm`, `enterWorld` — and it never touches a socket, a packet or a result code
directly. Every user-visible string comes from `GlueStrings`; every sprite comes from a `GlueArt`
table keyed by name, with the authored tex-coords the probe screen skipped (the probe drew whole
sheets, which is why its button looked like a strip).

`login-state.ts` is the one piece of logic worth testing on its own: given a stage and the last
refusal, it answers which dialog should be up and what it says. That keeps the mapping out of the
layout code and makes the interesting half testable without a canvas.

### 3.2 Where the address and the saved name live

Both go through `connection-settings.ts` from spec 2, which is currently inert — this screen is its
first consumer. The address field reads `loadSettings()` on mount and writes `saveSettings()` on
submit. The saved account name rides the same store, since it is the same kind of thing: a local
preference, not game state.

### 3.3 Routing

`/glue` becomes `/`. The old routes go: `/realms` and `/characters` are removed along with their
components, and `/game` keeps working exactly as it does, including `?offline=1`. A player who lands
on `/` sees the login screen; the machine's stage decides everything after that.

## 4. Testing

Essential only, by the project's standing decision: the happy path, plus a regression test whenever
something actually breaks.

1. `login-state.ts` — a stage plus a refusal maps to the right dialog and the right string key,
   including no dialog when there is nothing to say.
2. The screen submits what the player typed: with a fake protocol session, typing an account and
   password and pressing the Login button calls `login()` with exactly those values.
3. The saved account name round-trips: submitting with the box checked restores the name on the next
   mount, and unchecked does not.

Everything visual is verified in a browser, as spec 1's was: the screen against the reference for
layout and art, the dialogs against a real refusal, and the routes still serving. That check found
three bugs in spec 1 that no test would have.

## 5. Out of scope

Sound (`PlayGlueMusic`/`PlayGlueAmbience` are still nothing in this repo), the realm-list and
character screens beyond the two stubs, character appearance, and the in-world HUD. The provisional
`CHAR_CREATE_*` codes stay provisional — nothing here creates a character.
