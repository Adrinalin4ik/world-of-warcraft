# FrameXML Lua Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the game client's own `AccountLogin.xml` and its Lua, and serve the result at `/` in place of the hand-transcribed login screen.

**Architecture:** A Lua 5.1-compatible VM (fengari plus a small compatibility shim) hosting the FrameXML object model — frame wrapper tables with per-kind method dispatch — driven by a loader that materializes XML by *calling* `CreateFrame` and `SetPoint` exactly as an addon does, never by reaching into the widget tree. Engine globals are short bridges to the `ProtocolSession` and `connection-settings` that already work against a live server. The document layer from plan 1 (`toc.ts`, `xml.ts`, `templates.ts`, `order.ts`) supplies everything upstream.

**Tech Stack:** TypeScript, `fengari` (MIT, Lua 5.3 core — see the compatibility note below), jest. One new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-06-framexml-runtime-design.md`. §7 (the Lua boundary) and §8 (the engine API) are what this plan implements; §9 is how it is verified. Read §7 before Task 2 and §9 before Task 9.

**This is plan 2 of 2.** Plan 1 (`2026-08-06-framexml-document-layer.md`) is complete and merged.

## Global Constraints

- **Happy path tests only.** The project owner's standing instruction, stated four times. **Two tests per task at most, one where one will do.** No error-path tests, no edge cases, no one-test-per-branch. Where a rule is subtle it goes in a comment, not in a test nobody asked for.
- **The loader drives the object model, never the widget tree.** It calls the Lua global `CreateFrame` and the wrapper's own methods. This is the single decision that decides whether addons can ever work, and a direct path would be faster and wrong.
- **Never throw on bad input.** A bad handler body, an unknown frame type, a missing include, an unsupported attribute: each is an entry in a `LoadReport` and the load continues. The client logs and continues. Warnings dedupe — a document with 200 unsupported handlers must not emit 200 identical lines.
- **Read `virtual` before expansion, never after.** Proven on real data: `AccountLoginLoginButton` inherits `GlueButtonTemplateBlue` and comes out of `TemplateRegistry.expand` carrying `virtual="true"`, which it never declared. A loader that classifies on the expanded element would treat every button that inherits a virtual template as a template and never materialize it.
- **Regions sit at their owner's frame level; only child frames are born at `parent + 1`.** Plan 1 fixed `Widget#add` for this; do not reintroduce the `+1` for `texture` and `fontstring`.
- **Reference fidelity.** The reference is `samples/benilla/crates/benilla-ui`. Where a rule comes from it, the comment says which file and what bug the rule prevents. Where something is ours, the comment says that instead.
- `cd client && npx tsc --noEmit -p tsconfig.json` at zero and `cd client && npm test -- --watchAll=false` green after every task. The suite is at 140 suites / 1641 tests before this plan.
- Watch for a typographic apostrophe (U+2019) inside single-quoted strings — it has broken this repo's parser five times.

## The Lua 5.1 question, settled

fengari is Lua **5.3**; WoW is **5.1**. All 27 glue Lua files were scanned for the constructs that differ: `setfenv`/`getfenv`, `string.gfind`, `math.mod`, `loadstring`, `arg[...]`, `module()`, `table.setn` — **zero occurrences**. `unpack(` — one, in `glueparent.lua`. `getn(` — one, in a file we do not load. `//` — 68 hits, every one `http://` inside a string.

So the gap for Blizzard's own glue code is two call sites. **The shim lives in exactly one module** (`lua/compat.ts`), because third-party addons are not as disciplined and a future swap to an Emscripten Lua 5.1 must be contained rather than an excavation.

## File Structure

| File | Responsibility |
|---|---|
| `client/src/game/ui/framexml/lua/vm.ts` | Create the fengari state, run a chunk, convert values, own the error path. |
| `client/src/game/ui/framexml/lua/compat.ts` | The 5.1 shim, and nothing else. `unpack`, `getn`, and whatever else a real file needs. |
| `client/src/game/ui/framexml/lua/object.ts` | `CreateFrame`, wrapper tables, the shared metatable, per-kind dispatch, `_G` publication. |
| `client/src/game/ui/framexml/lua/methods/frame.ts` | The methods every frame has: visibility, identity, layout, strata/level. |
| `client/src/game/ui/framexml/lua/methods/region.ts` | Texture and FontString methods. |
| `client/src/game/ui/framexml/lua/methods/kinds.ts` | Button, CheckButton, EditBox — the per-kind tables that make duck-typing work. |
| `client/src/game/ui/framexml/lua/scripts.ts` | `SetScript`, handler compilation, and the dual calling convention. |
| `client/src/game/ui/framexml/lua/events.ts` | `RegisterEvent` and the ordered live-list dispatch. |
| `client/src/game/ui/framexml/lua/api/*.ts` | Engine globals, one module per subject. |
| `client/src/game/ui/framexml/loader.ts` | Walk a document, materialize each instance, fire `OnLoad` bottom-up. |
| `client/src/game/ui/framexml/runtime.ts` | The façade: load a `.toc`, expose the frame tree, drive `tick`. |
| `client/src/game/ui/screens/framexml-screen.ts` | A `GlueScreen` that hosts the runtime, so `GlueApp` needs no special case. |

---

### Task 1: The VM and the 5.1 shim

**Files:**
- Modify: `client/package.json` — add `fengari`
- Create: `client/src/game/ui/framexml/lua/vm.ts`, `lua/compat.ts`
- Test: `client/src/game/ui/framexml/lua/__tests__/vm.test.ts`

**Interfaces:**
- Produces:
  - `export class LuaVM { run(source: string, chunkName: string): LuaError | null; call(fn: LuaRef, args: unknown[]): LuaError | null; setGlobal(name: string, value: unknown): void; getGlobal(name: string): unknown; registerFunction(name: string, fn: (args: unknown[]) => unknown[]): void; dispose(): void }`
  - `export type LuaError = { message: string; chunk: string }`
  - `export type LuaRef = { readonly __lua: unique symbol }` — an opaque handle to a Lua value.
  - `export function installCompat(vm: LuaVM): void` — from `compat.ts`.

**Notes:**
- `run` returns an error rather than throwing, per the global constraint.
- The shim is `unpack = table.unpack` and `getn = function(t) return #t end`, plus `GetLocale()` returning `'enUS'` and `GetTime()` reading a clock the runtime advances. Each line gets a comment saying why it exists — a shim entry with no reason is indistinguishable from a mistake later.
- fengari's JS interop is not obvious. Read its `fengari-interop` docs or source before designing `registerFunction`; do not guess at the stack protocol.

- [ ] **Step 1: Add the dependency**

```bash
cd client && npm install --save fengari
```

- [ ] **Step 2: Write the failing test**

```ts
import { LuaVM } from '../vm';
import { installCompat } from '../compat';

describe('LuaVM', () => {
  it('runs a chunk, calls a registered function, and reads a global back', () => {
    const vm = new LuaVM();
    installCompat(vm);
    const seen: unknown[][] = [];
    vm.registerFunction('Record', (args) => {
      seen.push(args);
      return ['ok'];
    });

    // `unpack` is the one 5.1-ism Blizzard's own glue code uses (glueparent.lua), so the shim is
    // exercised here rather than in a test of its own.
    const error = vm.run('answer = Record("a", 2, unpack({3}))', 'test');

    expect(error).toBeNull();
    expect(seen).toEqual([['a', 2, 3]]);
    expect(vm.getGlobal('answer')).toBe('ok');
  });

  it('returns a syntax error rather than throwing', () => {
    const vm = new LuaVM();
    const error = vm.run('this is not lua', 'bad.lua');

    expect(error).not.toBeNull();
    expect(error!.chunk).toBe('bad.lua');
  });
});
```

- [ ] **Step 3: Run it and watch it fail** — `cd client && npm test -- --watchAll=false --testPathPattern=lua/__tests__/vm`
- [ ] **Step 4: Implement `vm.ts` and `compat.ts`**
- [ ] **Step 5: Run it and watch it pass**, then `npx tsc --noEmit -p tsconfig.json`
- [ ] **Step 6: Commit** — `feat(lua): a Lua VM with the 5.1 shim the glue code needs`

---

### Task 2: The object model

**Read spec §7 first.** This is the task the addon goal rests on.

**Files:**
- Create: `client/src/game/ui/framexml/lua/object.ts`
- Test: `client/src/game/ui/framexml/lua/__tests__/object.test.ts`

**Interfaces:**
- Consumes: `LuaVM` from `./vm`; `Widget`, `WidgetKind` from `../../widget`.
- Produces:
  - `export class FrameRegistry { create(kind: string, name: string | null, parent: number | null): number; widget(id: number): Widget | null; byName(name: string): number | null }`
  - `export function installObjectModel(vm: LuaVM, registry: FrameRegistry): void` — registers `CreateFrame` and the metatable machinery.

**The rules, each with its reason:**

1. **A frame's Lua value is a table, not userdata**, carrying its integer id, with a shared metatable whose `__index` dispatches by method name.
2. **Wrappers are cached per id**, so `GetParent()` returns the *same* table every time. Identity has to be stable or `frame == otherFrame` in Lua lies.
3. **Per-kind method tables, consulted before the shared one.** Addons duck-type widgets (`if frame.SetValue then`), so a plain Frame must resolve `SetValue` to **nil**. One flat table would make every frame quack like every widget. CheckButton resolves through `[CHECKBUTTON, BUTTON]` — the class chain.
4. **Named frames publish to `_G` non-overwriting** — the first frame with a name owns it.
5. **An unknown frame kind is a hard Lua error**, unlike everything else here, because `CreateFrame` is the client's own validation point.
6. **A child enters its parent's strata at the parent's level + 1** — except regions, which plan 1's `Widget#add` already handles. Do not re-add the `+1` here.

**Test budget: one.** A frame created through Lua resolves its own methods, a plain Frame answers nil to a Button method, and `_G` carries the name — all in one test, because they are one mechanism.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run it and watch it pass**, then `tsc`
- [ ] **Step 5: Commit** — `feat(lua): the FrameScript object model`

---

### Task 3: Frame and region methods

The 60-method surface, measured against what the glue Lua actually calls.

**Files:**
- Create: `lua/methods/frame.ts`, `lua/methods/region.ts`
- Test: `lua/__tests__/methods.test.ts`

**Frame** (`frame.ts`): `Show Hide IsShown IsVisible GetName GetID SetID GetParent SetFrameStrata GetFrameStrata SetFrameLevel GetFrameLevel SetAlpha GetAlpha SetWidth SetHeight GetWidth GetHeight SetPoint ClearAllPoints SetAllPoints EnableMouse SetBackdrop SetBackdropColor SetBackdropBorderColor RegisterEvent UnregisterEvent SetScript GetScript CreateTexture CreateFontString Raise SetScale GetEffectiveScale`

**Region** (`region.ts`): `Show Hide IsShown SetText GetText SetFormattedText SetTexture SetVertexColor SetTextColor SetAlpha SetWidth SetHeight SetPoint ClearAllPoints SetAllPoints SetTexCoord SetDrawLayer SetFontObject SetFont GetStringWidth SetJustifyH SetJustifyV SetDesaturated SetBlendMode`

**Model-frame** (also `frame.ts`, mapping onto the existing glue scene): `SetModel SetCamera SetSequence SetFogNear SetFogFar SetFogColor ClearFog SetGlow`

**Two rules with bugs attached:**
- **`SetFrameLevel` with the same value must early-out** and not re-stamp the link order. Re-stamping on a no-op set is what makes a frame jump to the front of its bucket for no reason.
- **`SetTexture("")` clears the slot** — the live API's blank form, which real FrameXML uses.

**Test budget: two.** One that a `SetPoint` through Lua produces the same rect the TypeScript path does; one that `SetFrameLevel` to the same value leaves the draw order untouched while a changed value re-stamps it.

- [ ] Steps as Task 1. Commit: `feat(lua): the frame and region method surface`

---

### Task 4: Per-kind methods and the class chain

**Files:** Create `lua/methods/kinds.ts`; test in the same `methods.test.ts`.

**Button:** `SetText GetText GetFontString Enable Disable IsEnabled LockHighlight UnlockHighlight SetButtonState GetButtonState Click SetNormalTexture GetNormalTexture SetPushedTexture SetDisabledTexture SetHighlightTexture SetNormalFontObject SetHighlightFontObject SetDisabledFontObject SetTextColor`
**CheckButton** (own table, consulted before Button's): `SetChecked GetChecked SetCheckedTexture GetCheckedTexture`
**EditBox:** `SetText GetText SetFocus ClearFocus HasFocus SetMaxLetters SetTextInsets SetPassword SetAutoFocus HighlightText GetNumLetters`

**One rule with a bug attached:** a disabled button whose Disabled texture is null draws **nothing** — there is no fallback to Normal. That is the byte-verified client rule and it is what makes empty slots look empty.

**Test budget: one** — a CheckButton resolves `SetChecked` from its own table and `Enable` from Button's, and a plain Frame resolves neither.

- [ ] Steps as Task 1. Commit: `feat(lua): per-kind widget methods and the class chain`

---

### Task 5: Scripts and the calling convention

**Files:** Create `lua/scripts.ts`; test `lua/__tests__/scripts.test.ts`.

**The rules:**
1. A `<Scripts>` child's tag *is* the handler name. Compile as `return function(self, ...) <body> end`, named `<file>:<handler>` for debugging.
2. `OnLoad` is captured, **not fired** — the loader fires it after the `<Frames>` recursion, bottom-up.
3. The handler name is validated against a fixed list; an unknown one is a warning, not an error.
4. **Both conventions, every call.** Set the legacy globals `this`, `event`, `arg1..argN`; pass the same values positionally as `(self, event, ...)`; **restore the previous globals afterwards even on error**, so nested firing is safe. Inside one handler `this == self` and `arg1 == select(1, ...)`.
5. An empty body falls back to `function="GlobalName"`.

**Test budget: two.** One that a handler sees both `this` and `self`, and both `arg1` and `...`; one that the globals are restored after a nested fire.

- [ ] Steps as Task 1. Commit: `feat(lua): script handlers with both calling conventions`

---

### Task 6: Events

**Files:** Create `lua/events.ts`; test `lua/__tests__/events.test.ts`.

**The rules:**
1. `RegisterEvent` appends to an **ordered** per-event list; re-registering keeps the original position rather than adding a duplicate.
2. Dispatch walks **by index, re-reading the live list each step**, so a frame registered mid-dispatch is still visited in that dispatch.
3. **Cross-frame order is a law consumers depend on** — two frames writing the same FontString on one event means the last writer decides.
4. Events reach registered frames **regardless of visibility**.

**Test budget: one** — two frames registered for one event fire in registration order, and a third registered from inside the first handler is still visited.

- [ ] Steps as Task 1. Commit: `feat(lua): the event system, in registration order`

---

### Task 7: The loader

**Files:** Create `framexml/loader.ts`; test `framexml/__tests__/loader.test.ts`.

**Interfaces:**
- Produces: `export type LoadReport = { warnings: string[]; errors: string[]; frames: number }`, `export function loadDocument(runtime, doc, files): LoadReport`

**The eight steps of `materialize`, in order:** `CreateFrame(tag, resolvedName, parent)` → attributes → `<Size>` → `<Anchors>` → `<Layers>` and direct `<FontString>` and `<Backdrop>` and per-kind → `<Scripts>` (OnLoad captured) → recurse into `<Frames>` → fire OnLoad.

**The rules, each with its bug:**
1. **Bottom-up `OnLoad`.** Children are fully built and their handlers fired before the parent's runs.
2. **Every `<Size>` child applies, in order, last winning.** Taking the first pins every templated frame to its template's size.
3. **`$parent` asymmetry:** a frame's own anchors substitute against its **parent's** name; its regions and children substitute against **its own**.
4. **Classify on the pre-expansion element** — see the global constraint.
5. **State textures are created through the setter, then decorated through the getter** — `SetNormalTexture(file)` then `GetNormalTexture()` to apply size, anchors and tex-coords to what it made.
6. **`<ButtonText>` calls `SetText` even with no text**, because `SetText` is the slot's lazy constructor; without it a labelled button centres its text over its whole face.

**Test budget: two.** One flagship: a document with a template, an `inherits`, sizes, anchors, a layered texture, a nested frame and two `OnLoad`s — asserting the frame count, `$parent` resolution, both calling conventions, bottom-up order, and one exact rect. One that an instance's `<Size>` beats its template's.

- [ ] Steps as Task 1. Commit: `feat(framexml): materialize a document through the object model`

---

### Task 8: The engine API

**Files:** Create `lua/api/{screen,login,realms,sound,stubs}.ts`; test `lua/__tests__/api.test.ts`.

**Must actually work** (bridges to existing, already-server-tested code): `CreateFrame` (Task 2), `GetScreenWidth`, `GetScreenHeight`, `IsStreamingTrial`, `IsTrialAccount`, `IsWindowsClient`, `IsShiftKeyDown`, `GetBuildInfo`, `GetClientExpansionLevel`, `DefaultServerLogin`, `CancelLogin`, `DisconnectFromServer`, `GetSavedAccountName`, `SetSavedAccountName`, `GetSavedAccountList`, `SetSavedAccountList`, `GetUsesToken`, `SetUsesToken`, `RequestRealmList`, `CancelRealmListQuery`, `GetNumRealms`, `GetRealmInfo`, `GetRealmCategories`, `GetSelectedCategory`, `ChangeRealm`, `GetServerName`, `RealmListUpdateRate`, `SetCurrentScreen`, `LocalizeFrames`, `QuitGame`.

**No-ops that must merely exist** so a reference does not error: the `AccountMsg_*` family, `ShowTOSNotice`, `ShowEULANotice`, `ShowContestNotice`, `ShowScanningNotice`, `ShowTerminationWithoutNoticeNotice`, `ScanDLLStart`, `ScanDLLContinueAnyway`, `IsScanDLLFinished`, `PINEntered`, `TokenEntered`, `PlaySound`, `PlaySoundFile`, `PlayGlueMusic`, `PlayGlueAmbience`, `StopGlueAmbience`, `StopAllSFX`, `PlayCreditsMusic`, `Screenshot`, `LaunchURL`, `SetClearConfigData`, `SetPreferredInfo`, `StatusDialogClick`, `SurveyNotificationDone`, `TOSAccepted`, `EULAAccepted`, `ContestAccepted`, `ScanningAccepted`, `TerminationWithoutNoticeAccepted`, `GetChangedOptionWarnings`, `ShowChangedOptionWarnings`, `VideoOptionsFrame_SetAllToDefaults`, `VideoOptionsFrame_SetCurrentToDefaults`, `AudioOptionsFrame_SetAllToDefaults`, `AudioOptionsFrame_SetCurrentToDefaults`, `SetGameAccount`, `GetGameAccountInfo`, `GetNumGameAccounts`, `IsInvalidLocale`, `IsTournamentRealmCategory`, `IsInvalidTournamentRealmCategory`, `SetRealmSplitState`, `RequestRealmSplitInfo`, `RealmListDialogCancelled`, `SetCharCustomizeBackground`, `SetCharSelectBackground`.

**`GlueDropDownMenu_*` is not engine at all** — it is Lua, and comes free once `GlueDropDownMenu.xml` is in the load order.

**Every no-op gets a one-line comment saying which screen it belongs to**, so the next reader can tell a deliberate stub from a forgotten one.

**Test budget: one** — `DefaultServerLogin` reaches `ProtocolSession#login` with the typed account and password.

- [ ] Steps as Task 1. Commit: `feat(lua): the engine API the glue screens call`

---

### Task 9: Boot the real login screen, beside the transcription

**This is the oracle task.** Both screens exist at once and are compared; nothing is deleted yet.

**Files:** Create `framexml/runtime.ts`, `screens/framexml-screen.ts`; modify `pages/glue/index.tsx`.

- The runtime loads `Interface\GlueXML\GlueXML.toc` and runs its files in order, stopping after `AccountLogin.xml`.
- A URL flag selects which screen `/` mounts: `?ui=lua` gives the runtime, the default stays the transcription. That keeps the working screen the default until the runtime earns it.
- **Verification is a side-by-side browser diff**, not a test: `/` and `/?ui=lua` screenshotted at the same viewport, compared element by element — logo, both edit boxes and their captions, the Login and Quit buttons, the check button, the version block, the Blizzard logo, the disclaimer. Every difference is a defect in the runtime until proven otherwise, because the transcription already matches the project owner's reference screenshots of the real client.
- Report the `LoadReport`: frame count, and every warning and error. A warning here names a real gap.

**Test budget: none.** This task's verification is the browser diff and the load report.

#### Five prerequisites this task owns, discovered by tasks 2-8 and recorded in the ledger

Four of them are one root cause — nothing tears down a screen's Lua state — so build **one** teardown
mechanism rather than four patches:

1. `FrameRegistry.reset()` exists and has no caller. Screen teardown must call it, or registry slots
   grow on every session state change.
2. `scripts.ts`'s `handlersByFrame` retains a handle per script and is never cleared. `registry.onWrapperRelease`
   is single-subscriber and `installObjectModel` already claims it, so this needs a multi-subscriber
   teardown hook in `object.ts`.
3. `events.ts`'s `framesByEvent` has the same missing cleanup.
4. `frame.ts`'s `frameIds` map, backing `GetID`/`SetID`, likewise.

The fifth is separate and is the one that decides whether the diff means anything:

5. **An XML-loaded `<EditBox>` draws its border and nothing typed.** `screens.ts#resolveSprite`
   rasterizes glyphs only for `kind === 'fontstring'`, so the edit box widget itself renders no text.
   The authored structure tells you the fix: `accountlogin.xml:234` declares
   `<FontString inherits="GlueEditBoxFont"/>` as a direct child of the box — unnamed, no size, no
   anchors, purely a font declaration for the text the engine draws inside the `<TextInsets>` rect. So
   the loader should **adopt** that FontString as the box's text region: create it as a child fontstring
   widget, give it the declared font, and anchor it inside the box's `TextInsets`. Then this task's
   per-frame `update` mirrors the box's `displayText` into it.

   That is exactly what the hand-written screen does by hand — `screens/login.ts:583` creates the child
   and `login.ts:737` mirrors into it every frame — which is a useful confirmation that the design is
   right rather than a workaround. Adopt from the **declared** child, never by searching: the reference
   records that a find-first adoption once grabbed a chat header out of `<Layers>`, so typing overwrote
   the label.

   `loader.ts` already emits an `editbox:no-text-region` warning for every `<EditBox>`. That warning
   should disappear from the load report when this is done, which makes it the task's own progress check.

- [ ] Commit: `feat(framexml): serve the real AccountLogin.xml behind ?ui=lua`

---

### Task 10: Make it the default and delete the transcription

Only after Task 9's diff is clean.

- `/` mounts the runtime; the `?ui=lua` flag goes.
- Delete `screens/login.ts`, `screens/login-art.ts`, `screens/login-state.ts` (keeping `wantsTrialScene` and `clientStateForStage`, which are ours and not FrameXML's — move them), `screens/realms.ts`, `screens/realms-art.ts`, `screens/realm-list-state.ts`, and their tests.
- The `GlueArt` table goes too: the runtime resolves texture paths straight from the XML, so a hand-maintained key table has no consumer.

**Test budget: none** — this task only removes things. Verification is the full suite still green with the deleted tests gone, and the browser.

- [ ] Commit: `feat(framexml): the real client UI at /, and the transcription retired`

## Done criteria

- `/` renders `AccountLogin.xml` executed from the client's own files, matching the reference screenshots.
- Typing an account and password and pressing Login drives `ProtocolSession#login` through `DefaultServerLogin`, against a real server.
- The load report for the glue `.toc` names every gap rather than failing silently.
- `npx tsc --noEmit` at zero, the full suite green, and the hand-transcribed screens gone.

## Follow-ups this plan deliberately leaves

- **`CharacterSelect.xml` and `CharacterCreate.xml`** are not booted here. They are the payoff, but they need the character-list protocol work that the world handshake is currently blocking, and one screen proving the runtime is the honest milestone.
- **Addons.** The object model is built so they are possible, not so they work. `setfenv`, the `arg` table and true 5.1 vararg semantics are where fengari will bite first.
- **The `is-region` draw-order rank** and the two dropped strata, both recorded in plan 1's follow-ups.
