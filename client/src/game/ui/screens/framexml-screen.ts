/**
 * A `GlueScreen` that is the client's own interface, not a transcription of it.
 *
 * `screens/login.ts` and `screens/realms.ts` build `AccountLogin` and `RealmList` by hand from
 * `accountlogin.xml` and `realmlist.xml`, and they are right -- they match the reference screenshots of
 * the real client. This screen builds the same things by RUNNING that XML. Both exist at once on
 * purpose: the hand-written ones are the ORACLE, so every difference between them is a defect in the
 * runtime until it is shown otherwise, and `/?ui=lua` versus `/` is how that comparison is made. Nothing
 * is deleted until the diff is clean.
 *
 * ONE INSTANCE SERVES SEVERAL `ClientState`s, which is why this is `FrameXmlGlueScreen` and not
 * `FrameXmlLoginScreen`. The manifest this loads holds every glue frame at once -- `AccountLogin`,
 * `RealmList`, `AddonList`, `GlueDialog` -- and which of them is visible is a decision the client's own
 * Lua makes, by `Show`/`Hide`. So `pages/glue/index.tsx` registers this same object for `Login`,
 * `RealmList` AND `CharSelect`, and `GlueApp#enter` recognises it and does not remount: a glue-to-glue
 * transition must not tear down and reboot the Lua VM (see the comment there).
 *
 * `CharacterSelect.xml` and `CharacterCreate.xml` are both inside `stopAfter` now, so the third of
 * those states is served the same way
 * the second is -- by the document itself. `CharacterSelect` IS a glue screen (unlike `RealmList`): it
 * is in `GlueScreenInfo`, so `SetGlueScreen("charselect")` shows it and hides `AccountLogin`, and the
 * `charselect` row of `CLIENT_STATE_FOR_SCREEN` below is what tells the host machine it happened.
 *
 * ## What drives the 3D stage, now that the MODEL surface is real
 *
 * All of it comes down the client's own path, and this screen only translates:
 *
 *  - **Which model.** `AccountLogin_OnLoad` calls `self:SetModel("...UI_MainMenu_Northrend.m2")`
 *    (accountlogin.lua:34,36); character select and create call `GetSelectBackgroundModel(id)` ->
 *    `SetBackgroundModel` (pure Lua) -> `SetCharSelectBackground(path)` -> `onSetBackgroundModel`
 *    below. `SetModel` was a warn-once stub and this screen used to set the login token itself; it is
 *    a real method now (`framexml/lua/methods/model.ts`) and `pushModelState` honours it.
 *  - **Fog, glow, the light rig, the sequence slot and the camera index.** `SetLighting`
 *    (glueparent.lua:327) issues every one of those at the model frame, and `pushModelState` below
 *    reads the resulting `Widget#modelRig` once per tick.
 *  - **Where the character draws.** `SetCharSelectModelFrame("CharacterSelect")`
 *    (characterselect.lua:33) names the frame, and `SelectCharacter(id)` names the row. Both are
 *    honoured: a body is only put on the stage while the named frame is the one on screen.
 *
 * The one thing this screen still does that the document cannot: **the per-frame edit-box mirror**,
 * in `framexml/runtime.ts#update`.
 */
import { ClientState, GlueContext, GlueScreen } from '../screens';
import type { CharacterRecord } from '../../../network/protocol/types';
import type { ModelRig } from '../scene/scene-rig';
// TYPE-ONLY, and the dynamic `import()` in `mount` below is the reason: `framexml/runtime.ts` pulls in
// fengari, a whole Lua VM, and a value import here would put it in the main bundle for every visitor of
// every route -- including the default screen, which does not use it. It is also the module with the
// browser-hostile node requires webpack has to be told about (`config/webpack.config.js`); keeping it in
// its own chunk means a problem there cannot blank the page for a screen that never asked for Lua.
import type { GlueRuntime } from '../framexml/runtime';
import { sceneFromPath } from '../scene/tokens';
import { wantsTrialScene } from './login-state';

/**
 * The client's screen names (`GlueScreenInfo`, glueparent.lua:11-19) to this app's `ClientState`.
 *
 * Only the three this app has a state for. A name absent here is not an error and not a silent drop:
 * `SetCurrentScreen` logs it (below), which is the honest answer for `realmwizard`, `credits`,
 * `options`, `movie`, `patchdownload` and `trialconvert` -- none of those documents is even loaded
 * (`stopAfter`), so a machine state for them would have nothing to show.
 *
 * `realmlist` is deliberately NOT here, and it is not an omission: `RealmList` is not a glue screen in
 * 3.3.5. It is absent from `GlueScreenInfo`, so `SetGlueScreen`/`SetCurrentScreen` never touch it --
 * `RealmList_OnEvent` shows it ITSELF on `OPEN_REALM_LIST` (realmlist.lua:11-19), as a
 * `frameStrata="DIALOG"` frame over the login screen it dims. See the report.
 */
const CLIENT_STATE_FOR_SCREEN: Record<string, ClientState> = {
  login: ClientState.Login,
  charselect: ClientState.CharSelect,
  charcreate: ClientState.CharCreate,
};

/**
 * `GlueScreenInfo`, glueparent.lua:9-18 -- a glue screen name to the frame it shows, verbatim for the
 * three whose root element is a `<ModelFFX>`.
 *
 * This is what tells the host WHOSE model state to obey. In the engine the question does not arise:
 * each `<ModelFFX>` owns its own model, so hiding `CharacterSelect` and showing `AccountLogin` simply
 * swaps which one draws. This client has one `GlueSceneView`, so the frame whose rig it follows has to
 * be named -- and naming it from `SetCurrentScreen`, the client's own announcement of which screen it
 * just put up (glueparent.lua:142-145), keeps the choice the document's rather than a guess.
 *
 * Only these three: the other six entries in `GlueScreenInfo` (`realmwizard`, `patchdownload`,
 * `trialconvert`, `movie`, `credits`, `options`) name plain `<Frame>`s in documents `stopAfter` does
 * not even fetch, and a name absent here leaves the stage on whatever it was showing.
 */
const MODEL_FRAME_FOR_SCREEN: Record<string, string> = {
  login: 'AccountLogin',
  charselect: 'CharacterSelect',
  charcreate: 'CharacterCreate',
};

export class FrameXmlGlueScreen implements GlueScreen {
  private runtime: GlueRuntime | null = null;
  /**
   * Which mount a boot belongs to. MONOTONIC, and a boolean is not enough.
   *
   * `GlueApp` reuses one screen instance across session-state changes, and `mount` starts an async
   * boot. With a single `unmounted` flag the hole was exactly at the trigger the teardown exists for:
   * mount starts boot #1 -> the state changes -> `unmount()` runs while `this.runtime` is still null,
   * so there is nothing to dispose -> `mount` clears the flag and starts boot #2 -> boot #1 resolves,
   * reads the flag as "still mounted", and installs itself. Runtime #1 was then never disposed -- VM
   * open, frames pinned, `window.glueRuntime` overwritten, its session subscriptions still firing into
   * a live Lua state attached to a root nobody draws. A token cannot be confused that way: a boot only
   * installs if the mount it was started for is still the current one.
   */
  private mountToken = 0;

  /** The mounted screen's context, so the per-tick model poll can reach `setModelRig`/`setScene`. */
  private ctx: GlueContext | null = null;

  /**
   * Which frame the client last said is on screen -- `MODEL_FRAME_FOR_SCREEN[SetCurrentScreen(name)]`.
   *
   * Starts at `AccountLogin` rather than null, because the boot's own `SetGlueScreen("login")` runs
   * INSIDE `bootGlueRuntime`, before `this.runtime` is assigned, and the notification therefore lands
   * on a screen that cannot yet poll. Seeding it means the first tick after the boot pushes the login
   * frame's state rather than nothing.
   */
  private activeModelFrame: string | null = 'AccountLogin';

  /**
   * `SetCharSelectModelFrame(name)` -- the frame the ENGINE draws the ROSTER character into. Null until
   * the client's Lua names one.
   *
   * Made real this round. It is the gate on `onSelectCharacter` below: a body goes on the stage only
   * while `activeModelFrame` is this frame, which is what stops the login screen inheriting a character
   * the character screen selected.
   *
   * SEPARATE from `charCustomizeFrame` below, and that is not symmetry for its own sake -- sharing one
   * field is a defect this round shipped and then found with `glueModelBridge`: both `OnLoad`s run in
   * the same boot, so `SetCharCustomizeFrame("CharacterCreate")` overwrote this and the gate never
   * opened.
   */
  private charSelectFrame: string | null = null;

  /**
   * `SetCharCustomizeFrame(name)` -- the create screen's twin. RECORDED and not yet consumed.
   *
   * Character create is piece 10 and out of scope here: the document is loaded but no screen is
   * registered for `ClientState.CharCreate`, and the preview it wants is a look assembled from engine-
   * owned dial state rather than a roster row. Kept because it is the other half of the same engine
   * concept and because piece 10's whole model half is "make this frame's name mean what the select
   * one's already does" -- storing it now is what makes that a one-line change rather than a
   * re-plumbing.
   */
  private charCustomizeFrame: string | null = null;

  /**
   * The last roster row `SelectCharacter` named, held so the gate can open later.
   *
   * `CharacterSelect_SelectCharacter` runs while `CharacterSelect` is up, so in practice the gate is
   * already open -- but `SelectCharacter` is also reachable from `CharacterSelect_OnShow`'s own
   * refresh path, and holding the record rather than dropping it means a selection that arrives one
   * tick before `SetCurrentScreen("charselect")` still puts a body on the stage.
   */
  private pendingCharacter: CharacterRecord | null = null;

  /** What `pushModelState` last handed the scene view, so an unchanged rig costs one comparison. */
  private pushed: {
    frame: string | null;
    rig: ModelRig | null;
    revision: number;
    modelPath: string | null;
  } = { frame: null, rig: null, revision: -1, modelPath: null };

  mount(ctx: GlueContext): void {
    // Any runtime still installed belongs to a previous mount that never got an `unmount` (or got one
    // that arrived before its boot finished). Dispose it here rather than orphaning it.
    this.runtime?.dispose();
    this.runtime = null;
    const token = ++this.mountToken;
    this.ctx = ctx;
    this.activeModelFrame = 'AccountLogin';
    this.charSelectFrame = null;
    this.charCustomizeFrame = null;
    this.pendingCharacter = null;
    this.pushed = { frame: null, rig: null, revision: -1, modelPath: null };

    // A PREFETCH, and no longer a decision. `AccountLogin_OnLoad` will call
    // `SetModel("...UI_MainMenu_Northrend.m2")` itself and `pushModelState` honours it -- but the boot
    // fetches and runs 24 files first, several seconds on a cold cache, and without this the screen
    // would sit on black for all of it. So the host asks for the token the document is about to ask
    // for, and `setScene`'s own token guard makes the document's call a no-op rather than a reload.
    //
    // The one case where the two disagree is `?trial=1` (or `?expansion=<2`): this reads the URL, while
    // `IsStreamingTrial()` is hardcoded false (`framexml/lua/api/screen.ts:108`, because this build
    // ships only the Wrath assets). The DOCUMENT then wins a moment later, which is the right way round
    // -- that URL knob exists for the hand-written screens, which have no Lua to fork on.
    ctx.setScene({ kind: 'mainmenu', streamingTrial: wantsTrialScene(window.location.search) });

    void import('../framexml/runtime')
      .then(({ bootGlueRuntime }) =>
        bootGlueRuntime({
          root: ctx.root.root,
          art: ctx.art,
          protocol: ctx.protocol,
          // The screen's own focus router, which is what `EditBox:SetFocus`/`ClearFocus`/`HasFocus`
          // move and read (`framexml/lua/object.ts`'s `FocusSink`). The `GlueContext` has had it all
          // along; nothing was passing it, which is why those three were warn-once no-ops and why
          // `AccountLogin_OnShow`'s "focus the account name" did nothing.
          input: ctx.input,
          // `CharacterCreate.xml`, not `CharacterSelect.xml`, and the reason is on the CHARACTER
          // SELECT screen: `CHARACTER_FACING_INCREMENT` -- the rotate arrows' per-frame step -- is
          // defined at `charactercreate.lua:1` and read at `characterselect.lua:501,507`. The client
          // loads both documents (`GlueXML.toc` has them adjacent, create straight after select), so
          // this is the reference's own load list rather than a widened one. Cost, measured: 371 ->
          // 432 frames, 29 -> 35 warnings, 0 -> 0 ERRORS. See
          // `framexml/lua/api/characters.ts#SetCharCustomizeFrame` for the one stub that keeps the
          // error count at zero, and note that `ClientState.CharCreate` still has no screen
          // registered -- the document is loaded, the screen is not booted.
          stopAfter: 'CharacterCreate.xml',
          onQuitGame: () => {
            // The same thing the transcription's Quit button can do in a browser: nothing to exit, so
            // leave an observable signal rather than pretending.
            window.dispatchEvent(new CustomEvent('wow:quit'));
          },
          // `SetCurrentScreen(name)` is what `SetGlueScreen` tells the ENGINE after it has done the
          // showing and hiding itself (glueparent.lua:142-145) -- it is a notification, not the switch.
          // So the honest binding is the host's own machine: the document has put a screen up, and this
          // is where the app is told which. Nothing is shown or hidden from here; the client's Lua
          // already did that.
          //
          // Harmless when it names the state already current -- `GlueApp#enter` recognises the same
          // screen instance and does not remount -- which is what makes the boot's own
          // `SetGlueScreen("login")` a no-op rather than a rebuild.
          onSetCurrentScreen: (name) => {
            // WHICH MODEL FRAME IS ON SCREEN. In the engine this needs no code at all: each
            // `<ModelFFX>` owns its own model, so hiding `CharacterSelect` and showing `AccountLogin`
            // swaps which model draws. One shared `GlueSceneView` has to be told which frame's state
            // to follow, and `SetCurrentScreen` is the client's own announcement of exactly that.
            //
            // This used to re-set the login token by hand here, with a comment saying the trigger was
            // the document's even if the value was not. Both are the document's now: the switch below
            // makes `AccountLogin`'s rig active, and `pushModelState` reloads the stage from the
            // `SetModel` path that frame is still holding.
            const frame = MODEL_FRAME_FOR_SCREEN[name];
            if (frame !== undefined) {
              this.activeModelFrame = frame;
            }
            const next = CLIENT_STATE_FOR_SCREEN[name];
            if (next === undefined) {
              console.log(`framexml: SetCurrentScreen(${name}) -- no ClientState for that screen`);
              return;
            }
            ctx.go(next);
          },
          // `SetBackgroundModel` -> `SetCharSelectBackground(path)`, straight from the client's Lua.
          // The path is parsed rather than pattern-matched against a race, so the token the document
          // named is the token the stage loads -- including `DEATHKNIGHT`, which is not a race.
          onSetBackgroundModel: (path) => {
            const scene = sceneFromPath(path);
            if (scene === null) {
              console.warn(`framexml: SetCharSelectBackground("${path}") -- not a UI_<name>.m2 path`);
              return;
            }
            ctx.setScene(scene);
          },
          // `SelectCharacter(id)` -> the body on the stage. See `GlueRuntimeOptions` for why this is a
          // second hook and not a reading of the stage path, and `scene/character-look.ts` for what
          // this milestone draws and what it knowingly leaves blank.
          //
          // GATED on `SetCharSelectModelFrame`, which is the whole of that call being real: the record
          // is remembered and `pushModelState` puts it on the stage while the named frame is the one on
          // screen. Before this, a selection made on character select would have kept its body standing
          // on the login stage.
          onSelectCharacter: (character) => {
            this.pendingCharacter = character;
          },
          // `SetCharSelectModelFrame(name)` (characterselect.lua:33) and its create-side twin
          // `SetCharCustomizeFrame(name)` (charactercreate.lua:75) -- which frame the ENGINE draws the
          // character model into. Both were no-ops registered in `api/characters.ts` on the grounds
          // that there was no character model to point anywhere; there is one now.
          onCharacterModelFrame: (kind, name) => {
            if (kind === 'select') {
              this.charSelectFrame = name;
            } else {
              this.charCustomizeFrame = name;
            }
          },
          // `SetCharacterSelectFacing(degrees)` -- the drag-to-rotate and the rotate arrows both write
          // it, so this is the one value the stage turns by. See `GlueRuntimeOptions` for the unit.
          onSetCharacterFacing: (degrees) => {
            ctx.setCharacterFacing(degrees);
          },
        }),
      )
      .then((runtime) => {
        // Superseded by a later mount, or unmounted outright (which bumps the token too): this boot's
        // runtime is nobody's, and it is the only thing holding a reference to it.
        if (token !== this.mountToken) {
          runtime.dispose();
          return;
        }
        this.runtime = runtime;
        reportLoad(runtime);
        // A console handle on the live runtime, in the spirit of `skyDebug` and `framexml.help()`.
        // This is how the screen is INTERROGATED rather than guessed at: `glueRuntime.vm.run('...')`
        // runs a line of Lua against the tree that is on screen, which is the only way to exercise
        // paths a static screenshot cannot reach -- an edit box's text region, for one, since nothing
        // in this runtime makes an XML-loaded box mouse-focusable yet.
        (window as never as Record<string, unknown>).glueRuntime = runtime;
        // The session BESIDE the runtime, because half the questions this screen raises are about what
        // the engine API was handed rather than about what Lua did with it -- and with no world
        // handshake (both of the owner's servers answer AUTH_REJECT today) staging a roster on the
        // session is the only way to reach the character screen at all. A read handle on an object the
        // page already owns; nothing here mutates it.
        (window as never as Record<string, unknown>).glueSession = ctx.protocol;
        // The MODEL BRIDGE's own state, beside the other two and for exactly the reason the class
        // comment on `glueScene` gives: "is a character loaded" and "why is it not" are not answerable
        // from a screenshot. This bridge has three independent inputs -- which screen the client says is
        // up, which frame it says owns the character, and which row it selected -- and a body that never
        // appears looks the same whichever of the three is missing. One live getter, no state of its own.
        (window as never as Record<string, unknown>).glueModelBridge = {
          state: () => ({
            activeModelFrame: this.activeModelFrame,
            charSelectFrame: this.charSelectFrame,
            charCustomizeFrame: this.charCustomizeFrame,
            pendingCharacter: this.pendingCharacter?.name ?? null,
            standing: this.standing?.name ?? null,
            pushed: {
              frame: this.pushed.frame,
              revision: this.pushed.revision,
              modelPath: this.pushed.modelPath,
            },
          }),
        };
      })
      .catch((error) => {
        // A boot that fails outright is the one thing `bootGlueRuntime` does not turn into a report
        // line, so it must not vanish into an unhandled rejection.
        console.error('framexml: the runtime failed to boot', error);
      });
  }

  update(dt: number): void {
    this.runtime?.update(dt);
    this.pushModelState();
  }

  /**
   * The MODEL bridge: read the active model frame's own state and hand what changed to the stage.
   *
   * A POLL rather than a callback, and `lua/methods/model.ts`'s header argues why in full -- the short
   * version is that one `SetLighting` is up to 41 method calls for one visible change, so a monotonic
   * `revision` compared once per tick rebuilds the fold once instead of 41 times. It is the reference's
   * own gate (`glue_booth.rs:816-819`).
   *
   * Three things are pushed, in this order and for these reasons:
   *
   *  1. **The scene**, from `SetModel`. Only when the frame actually named one -- `CharacterSelect`
   *     never calls `SetModel` (its stage arrives through `SetCharSelectBackground`), so a null path
   *     must leave the stage alone rather than tear it down.
   *  2. **The rig**, whenever the frame changed or its revision moved. A frame swap re-pushes even at
   *     an unchanged revision, because the value the scene view is holding belongs to the other frame.
   *  3. **The character**, gated on `SetCharSelectModelFrame`. `null` is pushed when the gate closes,
   *     which is what takes the body off the stage on the way back to the login screen -- and the
   *     pending record is KEPT, so returning to character select restands the same character without
   *     waiting for another `SelectCharacter`.
   */
  private pushModelState(): void {
    const ctx = this.ctx;
    const runtime = this.runtime;
    if (ctx === null || runtime === null) {
      return;
    }

    const frame = this.activeModelFrame;
    const id = frame === null ? null : runtime.registry.byName(frame);
    const rig = (id === null ? null : runtime.registry.widget(id)?.modelRig) ?? null;
    const frameChanged = frame !== this.pushed.frame;

    if (frameChanged || rig !== this.pushed.rig || (rig !== null && rig.revision !== this.pushed.revision)) {
      // The scene first, so the stage is already loading by the time its rig is pushed at it --
      // `GlueSceneView#applyRig` re-folds against whatever model is in hand and re-folds again when the
      // `.m2` lands, so either order is correct; this one just avoids a frame of the old stage lit by
      // the new rig.
      const path = rig?.modelPath ?? null;
      if (path !== null && (frameChanged || path !== this.pushed.modelPath)) {
        const scene = sceneFromPath(path);
        if (scene === null) {
          console.warn(`framexml: ${frame}:SetModel("${path}") -- not a UI_<name>.m2 path`);
        } else {
          ctx.setScene(scene);
        }
      }
      ctx.setModelRig(rig);
      this.pushed = { frame, rig, revision: rig?.revision ?? -1, modelPath: path };
    }

    // The character's frame, and the ONE state this keeps of its own: whether a body is standing.
    // Compared against `pushed.frame` above rather than tracked separately, because the gate can only
    // change when the active frame does or when `SetCharSelectModelFrame` first names one.
    const wanted =
      this.charSelectFrame !== null && this.charSelectFrame === frame ? this.pendingCharacter : null;
    if (wanted !== this.standing) {
      this.standing = wanted;
      // Logged, because this is the one decision on this screen that is invisible when it goes wrong: a
      // body that never appears looks exactly like a body still fetching, and the first version of this
      // poll deduped itself into never re-pushing after a cancel. One line per transition, and there are
      // at most a handful per screen.
      console.debug(
        `framexml: SetCharSelectModelFrame "${this.charSelectFrame}" vs screen "${frame}" -- ` +
          `${wanted ? `standing ${wanted.name}` : 'clearing the stage'}`,
      );
      ctx.setCharacter(wanted);
    }
  }

  /** The record currently on the stage, so an unchanged selection does not re-resolve its look. */
  private standing: CharacterRecord | null = null;

  unmount(): void {
    // Bumping the token IS the unmount signal: an in-flight boot compares against it and disposes
    // itself, and a later `mount` gets a token of its own rather than clearing a shared flag.
    this.mountToken += 1;
    // THE teardown path (`object.ts`'s `FRAME_TEARDOWN`): this releases every wrapper handle, every
    // stored script handler, every event registration and every side-table entry, then closes the VM.
    this.runtime?.dispose();
    this.runtime = null;
    // The model bridge's own state goes with the runtime: every frame it named is gone, so a rig or a
    // pending selection kept here would be pushed at the next mount's stage from a torn-down tree.
    this.ctx = null;
    this.charSelectFrame = null;
    this.charCustomizeFrame = null;
    this.pendingCharacter = null;
    this.standing = null;
    this.pushed = { frame: null, rig: null, revision: -1, modelPath: null };
    delete (window as never as Record<string, unknown>).glueRuntime;
    delete (window as never as Record<string, unknown>).glueSession;
    delete (window as never as Record<string, unknown>).glueModelBridge;
  }
}

/**
 * The load report, on the console, flat.
 *
 * Flat lines and a table, not `console.log('report', object)`: a collapsed object row is invisible
 * until expanded and copies as nothing, which would make the most useful output of this whole exercise
 * the one part that cannot be pasted into a bug report.
 */
function reportLoad(runtime: GlueRuntime): void {
  const { report, files } = runtime;
  console.log(
    `framexml: ${report.frames} frames from ${files.length} files, ` +
      `${report.warnings.length} warnings, ${report.errors.length} errors`,
  );
  console.table(
    files.map((file) => ({
      file: file.file,
      kind: file.kind,
      frames: file.frames,
      warnings: file.warnings.length,
      errors: file.errors.length,
    })),
  );
  report.warnings.forEach((warning, index) => console.warn(`framexml warning ${index + 1}: ${warning}`));
  report.errors.forEach((error, index) => console.error(`framexml error ${index + 1}: ${error}`));
}
