/**
 * The CharacterSelect screen's engine surface, backed by `ProtocolSession#characters`.
 *
 * Every global here was read out of `interface/gluexml/characterselect.lua` (build 12340) and
 * `characterselect.xml`, not guessed at. The brief's list was close but not exact in two places, and
 * both corrections are load-bearing:
 *
 *  - it is `GetCharacterSelectFacing`/`SetCharacterSelectFacing`, not `GetCharSelectFacing`
 *    (characterselect.lua:480,495,501,507). A `GetCharSelectFacing` would have been a nil global on the
 *    first mouse-drag of the model.
 *  - the delete path is `DeleteCharacter(index)` (characterselect.xml:1010,1090), an INDEX not a guid,
 *    and it has a sibling the brief did not name: `RenameCharacter(index, newName)`
 *    (characterselect.xml:1186,1257), which the `FORCE_RENAME_CHARACTER` dialog calls and which must
 *    return truthy/falsy because the caller branches on it.
 *
 * ## `GetCharacterInfo`'s tuple
 *
 * characterselect.lua:314 -- the one line that decides whether this screen renders correctly or renders
 * a plausible wrong screen:
 *
 * ```lua
 * local name, race, class, level, zone, sex, ghost, PCC, PRC, PFC = GetCharacterInfo(i);
 * ```
 *
 * Ten values, in that order. Three other call sites take a prefix of it and agree:
 * `CharSelectCharacterName:SetText(GetCharacterInfo(index))` takes only `name` (lua:259,265), and
 * `CharacterDeleteDialog_OnShow` takes `name, race, class, level` (lua:438). So a shift anywhere in the
 * first four is visible in the delete dialog too, which is a second witness rather than a second bug.
 *
 * `race` and `class` are the LOCALIZED NAMES, not ids: `SetFormattedText(CHARACTER_SELECT_INFO, level,
 * class)` against `"Level %d %s"` (gluestrings.lua:162) formats `class` with `%s`. A number there would
 * have rendered "Level 80 3" without erroring anywhere -- exactly the failure mode this comment exists
 * to prevent. `sex` is a number (the gender byte); `ghost`, `PCC`, `PRC` and `PFC` are truthiness tests
 * only.
 *
 * ## Where the three names come from, and why they come from two different places
 *
 * The engine reads all three out of DBCs it already holds. This client has to fetch them, and
 * `GetCharacterInfo` is synchronous, so the split is by CONTRACT, not by convenience:
 *
 *  - **race and class are static tables** (`ChrRaces.dbc` / `ChrClasses.dbc` name columns, enUS 12340,
 *    transcribed the same way `scene/tokens.ts` transcribes its race tokens). They MUST be strings on
 *    the first call: `UpdateCharacterList` feeds `class` straight into `format("Level %d %s", ...)`,
 *    and a nil there raises inside the client's own Lua. Both tables are complete for 3.3.5 -- eleven
 *    races and ten classes -- so there is no "unavailable" case to design for.
 *  - **zone is `AreaTable.dbc`, loaded through the app's own `DBC` reader** and cached here. It is ~1900
 *    rows; inlining it would be a data dump, not a transcription. Its contract is looser and the client
 *    states it itself: `if ( not zone ) then zone = "" end` (characterselect.lua:319-320). So a roster
 *    can paint before the DBC lands, and when it lands this re-fires `CHARACTER_LIST_UPDATE` so the zone
 *    column fills in. One extra event, never a stale blank.
 *
 * ## The gap this cannot close, named rather than faked
 *
 * `PCC`/`PRC`/`PFC` -- the three paid-service flags that decide whether a row shows the Customize /
 * Race Change / Faction Change button -- are always false, because `CharacterRecord` has no field for
 * them: `wotlk/world-wire.ts` reads the char-enum customization-flags u32 and discards it
 * (`u32(); // customization flags`). Making them real is a protocol-layer change (a field on the
 * version-neutral `CharacterRecord`, then the decoder), not a UI one, so it is reported here and in the
 * task report rather than approximated. The visible consequence is exactly nil: all three buttons stay
 * hidden, which is also what a server with no paid services outstanding would produce.
 */
import DBC from '../../../../pipeline/dbc';
import { LuaVM } from '../vm';
import { fireEvent } from '../events';
import { ProtocolSession } from '../../../../../network/protocol/session';
import { LoginStage } from '../../../../../network/protocol/stages';
import { CharacterRecord } from '../../../../../network/protocol/types';
import { raceKey } from '../../../scene/tokens';

/** `ChrRaces.dbc`'s name column, enUS, build 12340. Ids 9 (Goblin) and 12+ are not playable in 3.3.5. */
const RACE_NAMES: Record<number, string> = {
  1: 'Human',
  2: 'Orc',
  3: 'Dwarf',
  4: 'Night Elf',
  5: 'Undead',
  6: 'Tauren',
  7: 'Gnome',
  8: 'Troll',
  10: 'Blood Elf',
  11: 'Draenei',
};

/** `ChrClasses.dbc`'s name column, enUS, build 12340. There is no class 10. */
const CLASS_NAMES: Record<number, string> = {
  1: 'Warrior',
  2: 'Paladin',
  3: 'Hunter',
  4: 'Rogue',
  5: 'Priest',
  6: 'Death Knight',
  7: 'Shaman',
  8: 'Mage',
  9: 'Warlock',
  11: 'Druid',
};

/** Death knight, `ChrClasses` id 6 -- the one class whose glue model is not its race's. */
const DEATH_KNIGHT = 6;

/**
 * `CHARACTER_FLAG_GHOST`, the char-enum flag bit the reference's `ghost` value comes from. The record's
 * `flags` field is the raw u32 the decoder read, so this is the client's own test, not a derived one.
 */
const CHARACTER_FLAG_GHOST = 0x2000;

/** The stages in which a world connection is standing -- `IsConnectedToServer`. */
const CONNECTED_STAGES = new Set([
  LoginStage.CharacterList,
  LoginStage.EnteringWorld,
  LoginStage.InWorld,
]);

/**
 * Installs the character-select globals on `vm`, wired to `session`. Returns the `session.on`
 * unsubscribe, for a teardown that must not fire events into a closed Lua state.
 *
 * `onSetBackgroundModel` is the host's 3D stage, and it is optional in the sense that the API still
 * installs without it -- a screen that has no scene to drive says so once on the console rather
 * than pretending the background changed.
 */
export function installCharactersApi(
  vm: LuaVM,
  session: ProtocolSession,
  onSetBackgroundModel?: (path: string) => void,
  onSelectCharacter?: (character: CharacterRecord | null) => void,
  onSetCharacterFacing?: (degrees: number) => void,
): () => void {
  /**
   * The 1-based index the client last asked for through `SelectCharacter`.
   *
   * Held here rather than read off `CharacterSelect.selectedIndex`: in the engine the SELECTION is the
   * engine's (it is what `EnterWorld` and `DeleteCharacter` act on, neither of which takes an argument
   * saying which), and the Lua field is the screen's mirror of it, kept in step by the
   * `UPDATE_SELECTED_CHARACTER` event this fires. Reading the mirror instead would make the two able to
   * disagree, and `EnterWorld()` would then enter with whatever the screen last drew.
   */
  let selectedIndex = 0;

  /**
   * `SetCharacterSelectFacing`, in DEGREES. Real state: the client reads it straight back.
   *
   * The unit was recorded here as radians and that was wrong. `CHARACTER_ROTATION_CONSTANT = 0.6`
   * (characterselect.lua:4) turns a cursor PIXEL delta into this value and
   * `CHARACTER_FACING_INCREMENT = 2` (charactercreate.lua:1) is one frame of a held rotate arrow --
   * 0.6 per pixel is one turn across 600 authored pixels and 2 per frame is 120 per second, which are
   * degrees. As radians the same drag would be 57 revolutions.
   *
   * THE SINGLE OWNER of the character's facing. The drag and the rotate arrows both go through
   * `SetCharacterSelectFacing`, so there is one value and the host only mirrors it (see
   * `onSetCharacterFacing`); nothing downstream keeps a second copy it could disagree with.
   */
  let facing = 0;

  /** AreaTable id -> name, filled once the DBC lands. Empty until then; see the file comment. */
  const zoneNames = new Map<number, string>();
  let zonesRequested = false;

  const roster = (): CharacterRecord[] => session.characters;

  const at = (index: number): CharacterRecord | null => roster()[index - 1] ?? null;

  /**
   * Load `AreaTable.dbc` once and re-announce the roster, so the zone column fills in.
   *
   * Fired rather than mutated-in-place because the screen has already drawn by the time this resolves:
   * `CHARACTER_LIST_UPDATE` is the one door `characterselect.lua` re-reads `GetCharacterInfo` through
   * (`CharacterSelect_OnEvent` -> `UpdateCharacterList`), so re-announcing is the same path the initial
   * paint took. Guarded on having learned something, so a failed or empty DBC costs one fetch and no
   * event.
   */
  const primeZoneNames = (): void => {
    if (zonesRequested) {
      return;
    }
    zonesRequested = true;
    void Promise.resolve(DBC.load('AreaTable'))
      .then((table: { records?: { id: number; name?: string }[] }) => {
        for (const record of table?.records ?? []) {
          if (record && typeof record.name === 'string' && record.name !== '') {
            zoneNames.set(record.id, record.name);
          }
        }
        if (zoneNames.size > 0) {
          fireEvent(vm, 'CHARACTER_LIST_UPDATE');
        }
      })
      .catch(() => {
        // `DBC.load` already logs its own failure and answers an empty table; a missing zone column is
        // the client's own `zone = ""` case, not a screen failure.
      });
  };

  /**
   * `SET_GLUE_SCREEN` -- how the ENGINE, not the Lua, moves the player onto the character screen.
   *
   * Nothing in `interface/gluexml` calls `SetGlueScreen("charselect")`: `RealmList_OnOk` only calls
   * `ChangeRealm` and hides itself (realmlist.lua:258-268). The transition is the engine's, and it makes
   * it by firing this event -- `GlueParent_OnEvent`'s `SET_GLUE_SCREEN` branch is
   * `GlueScreenExit(GetCurrentGlueScreenName(), arg1)` (glueparent.lua:200-201), which for
   * login -> charselect fades `AccountLoginUI` out and only THEN calls `SetGlueScreen("charselect")`
   * through `GoToPendingGlueScreen`. So this fires the event and lets the client's own two-step run;
   * the fade is drained by `GlueParent`'s `<OnUpdate>`, which `framexml/runtime.ts#update` dispatches
   * for exactly this reason.
   *
   * Edge-triggered on ARRIVING at `CharacterList`. `refreshCharacters` is the only path that assigns
   * that stage, so this fires once per realm join (and again after a create/delete, which re-enters the
   * same stage) -- and re-firing while already on `charselect` would be harmless anyway, since
   * `GlueScreenExit`'s fade branch only matches when the current screen is `login`.
   */
  let announcedCharacterList = false;

  const unsubscribe = session.on((state) => {
    if (state.stage !== LoginStage.CharacterList) {
      announcedCharacterList = false;
      return;
    }
    if (state.characters.length > 0) {
      primeZoneNames();
    }
    if (!announcedCharacterList) {
      announcedCharacterList = true;
      fireEvent(vm, 'SET_GLUE_SCREEN', ['charselect']);
    }
  });

  vm.registerFunction('GetNumCharacters', () => [roster().length]);

  // The tuple. See the file comment for the destructuring line this matches, value for value.
  vm.registerFunction('GetCharacterInfo', (args) => {
    const character = at(Number(args[0] ?? 0));
    if (!character) {
      // Not an error: `CharacterSelect_OnEvent` calls this with `selectedIndex` while that is still 0,
      // and `UpdateCharacterList` has an explicit `if ( not name )` branch for it.
      return [];
    }
    return [
      character.name,
      RACE_NAMES[character.race] ?? '',
      CLASS_NAMES[character.class] ?? '',
      character.level,
      zoneNames.get(character.zoneId) ?? null,
      character.gender,
      (character.flags & CHARACTER_FLAG_GHOST) !== 0,
      // PCC / PRC / PFC -- see the file comment. `CharacterRecord` carries no customization flags.
      false,
      false,
      false,
    ];
  });

  /**
   * `SelectCharacter(id)` -- and the event is the whole of it.
   *
   * In the engine this is what moves the selection AND tells the screen: `CharacterSelect_OnEvent`'s
   * `UPDATE_SELECTED_CHARACTER` branch is the only thing that sets `CharSelectCharacterName` and calls
   * `UpdateCharacterSelection` (which is what locks the row's highlight). Without the event the click
   * would land, the engine would know, and nothing on screen would move.
   */
  vm.registerFunction('SelectCharacter', (args) => {
    const index = Number(args[0] ?? 0);
    selectedIndex = index;
    // The 3D stage's character. This is the client's own selection announcement, so the body that
    // stands on the stage is the row the player picked rather than a guess from the roster -- and it
    // is the same call `SetBackgroundModel` runs beside (characterselect.lua:430-433), so the stage
    // and the body can never disagree about who is selected.
    if (onSelectCharacter) {
      onSelectCharacter(at(index));
    }
    fireEvent(vm, 'UPDATE_SELECTED_CHARACTER', [index]);
    return [];
  });

  /**
   * `GetCharacterListUpdate()` -- `CharacterSelect_OnShow` asks the server to re-send the roster.
   *
   * `ProtocolSession` has no standalone roster re-fetch (one only happens as part of joining a realm or
   * a create/delete), so the honest bridge is the same one `RequestRealmList` uses: re-announce what the
   * session already holds through the event the client listens on.
   */
  vm.registerFunction('GetCharacterListUpdate', () => {
    fireEvent(vm, 'CHARACTER_LIST_UPDATE');
    return [];
  });

  vm.registerFunction('EnterWorld', () => {
    const character = at(selectedIndex);
    if (character) {
      void session.enterWorld(character.guid).catch(() => undefined);
    }
    return [];
  });

  /**
   * `DeleteCharacter(index)` -- an INDEX, per characterselect.xml:1010,1090; the session takes a guid.
   *
   * The session refreshes the roster itself afterwards and lands back on `CharacterList`, which fires
   * `CHARACTER_LIST_UPDATE` through `api/login.ts`, so nothing is announced from here.
   */
  vm.registerFunction('DeleteCharacter', (args) => {
    const character = at(Number(args[0] ?? 0));
    if (character) {
      void session.deleteCharacter(character.guid).catch(() => undefined);
    }
    return [];
  });

  /**
   * `RenameCharacter(index, name)` -- the `FORCE_RENAME_CHARACTER` dialog's accept path.
   *
   * Returns FALSE, and the return value is the point: characterselect.xml:1186 is
   * `if ( RenameCharacter(...) ) then ... hide the dialog ... end`, so a nil return would leave the
   * dialog up with no explanation. There is no rename in `WorldTransport` at all (no
   * `CMSG_CHAR_RENAME`), so false is the true answer -- the rename did not happen.
   */
  vm.registerFunction('RenameCharacter', () => {
    console.warn(
      'RenameCharacter: not implemented -- WorldTransport has no rename exchange; the dialog stays up',
    );
    return [false];
  });

  vm.registerFunction('GetCharacterSelectFacing', () => [facing]);
  vm.registerFunction('SetCharacterSelectFacing', (args) => {
    facing = Number(args[0] ?? 0);
    if (onSetCharacterFacing) {
      onSetCharacterFacing(facing);
    }
    return [];
  });

  /**
   * `GetSelectBackgroundModel(id)` -- the model TOKEN, upper-case, which becomes
   * `CharacterSelect.currentModel` and is then used two ways the client can see: as the key into
   * `GlueAmbienceTracks` (glueparent.lua:38-48, which is why it is upper-case) and as the
   * `== "DEATHKNIGHT"` test in `CharacterSelect_DeathKnightSwap`. A death knight's stage is the
   * Death Knight one whatever its race, which is that function's whole reason for existing.
   *
   * `scene/tokens.ts#raceKey` is the same table the host's own scene selection uses -- imported, not
   * restated, so the ambience key and the background scene cannot name different races.
   */
  vm.registerFunction('GetSelectBackgroundModel', (args) => {
    const character = at(Number(args[0] ?? 0));
    if (!character) {
      return ['CHARACTERSELECT'];
    }
    return [character.class === DEATH_KNIGHT ? 'DEATHKNIGHT' : raceKey(character.race)];
  });

  vm.registerFunction('IsConnectedToServer', () => [CONNECTED_STAGES.has(session.stage)]);

  // `CharacterSelect_OnShow`'s first line: the server is asked when account data last changed, so the
  // client knows whether to re-download keybindings. There is no account-data store in this client and
  // nothing reads the answer, so this is a genuine no-op rather than an unimplemented thing.
  vm.registerFunction('ReadyForAccountDataTimes', () => []);

  // Gameroom billing (Korea/China). `SHOW_GAMEROOM_BILLING_FRAME` is nil in this manifest so the branch
  // that reads these is never entered; they exist so it is a dead branch rather than a nil call the day
  // a locale build sets that flag. `paymentPlan == 0` is the reference's own "no payment plan" case.
  vm.registerFunction('GetBillingPlan', () => [0, 0, 0]);
  vm.registerFunction('GetBillingTimeRemaining', () => [0]);

  // `CharacterSelectUpgradeAccountButton`'s OnClick (characterselect.xml:397). `IsTrialAccount` is
  // already false (`api/screen.ts`), so the button is hidden and this is unreachable today.
  vm.registerFunction('UpgradeAccount', () => []);

  /**
   * The two model-frame calls, kept as real no-ops rather than declared gaps for one reason each:
   *
   *  - `SetCharSelectModelFrame(name)` names which frame the engine's character model draws into. There
   *    is no character model (see the task report -- bridging `<ModelFFX>` to the M2 pipeline is its own
   *    piece of work), so there is nothing to point at.
   *  - `UpdateSelectionCustomizationScene()` is called only from `CharacterSelect_UpdateModel`, which is
   *    an `<OnUpdate>`, which this runtime does not dispatch.
   *
   * `SetBackgroundModel` is deliberately NOT here, and that is a correction rather than an omission: it
   * LOOKS like an engine global and is not one -- glueparent.lua:374 defines it in Lua, so registering
   * it here would be dead code (the manifest loads after every `installXApi`) and, worse, a comment
   * claiming this client decided something the client's own Lua decides. What it calls through to IS
   * ours: `SetCharSelectBackground` (below) and the MODEL light methods in `methods/frame.ts`.
   *
   * The MODEL METHODS generally -- `SetModel`, `SetCamera`, `SetSequence`, `SetFog*`, `AdvanceTime`,
   * `ResetLights`, `Add*Light` -- ARE declared gaps, so the load report names the missing model from one
   * place instead of these duplicating the line from the function side.
   */
  vm.registerFunction('SetCharSelectModelFrame', () => []);
  vm.registerFunction('UpdateSelectionCustomizationScene', () => []);

  /**
   * `SetCharSelectBackground(path)` / `SetCharCustomizeBackground(path)` -- the two engine calls the
   * client's own `SetBackgroundModel` splits into (glueparent.lua:378-382), and the reason character
   * select shows the selected character's race stage at all.
   *
   * The whole chain is the client's, not ours: `CharacterSelect_SelectCharacter(id)` asks
   * `GetSelectBackgroundModel(id)` for a NAME, `SetBackgroundModel` turns that name into
   * `Interface\Glues\Models\UI_<name>\UI_<name>.m2`, and hands the PATH here
   * (characterselect.lua:430-431). So this takes a path and not a race, and the host reads the token
   * back out of it (`scene/tokens.ts#sceneFromPath`) rather than re-deriving one from the roster --
   * which is what keeps `CharacterSelect_DeathKnightSwap`'s `"DEATHKNIGHT"` stage, a name no race id
   * can express, working for free.
   *
   * Both names point at the same host callback because this client has ONE scene view: the engine
   * gives each `<ModelFFX>` its own model, and bridging that per-widget is the `MODEL.SetModel` gap
   * `methods/frame.ts` already declares. Only one of the two glue screens is ever up, so one view is
   * enough to be correct today; the day two model frames must draw at once, this is the seam.
   */
  // Warned once per VM, not once per call: `SetBackgroundModel` runs on every selection change, and
  // a line per click would bury the report the runtime exists to produce. The latch is a local of
  // this install, so a screen torn down and rebuilt is told again rather than inheriting silence.
  let warnedNoSink = false;
  const setBackground = (args: unknown[]): unknown[] => {
    const path = typeof args[0] === 'string' ? args[0] : '';
    if (!onSetBackgroundModel) {
      if (!warnedNoSink) {
        warnedNoSink = true;
        console.warn(
          `SetCharSelectBackground("${path}"): this runtime was booted with no background-model ` +
            'sink, so the 3D stage stays on whatever it was showing',
        );
      }
      return [];
    }
    onSetBackgroundModel(path);
    return [];
  };
  vm.registerFunction('SetCharSelectBackground', setBackground);
  vm.registerFunction('SetCharCustomizeBackground', setBackground);

  return unsubscribe;
}
