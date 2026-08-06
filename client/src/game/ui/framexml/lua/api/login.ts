/**
 * The AccountLogin/WoWAccountSelect engine surface: everything that reaches `ProtocolSession`, plus
 * the Remember-Account-Name persistence `accountlogin.lua` reads on every screen show.
 *
 * `DefaultServerLogin`/`CancelLogin`/`DisconnectFromServer` are the three calls that drive the
 * session's own state machine (`network/protocol/session.ts`); everything else here (`GetSavedAccountName`
 * and friends) is local persistence the login screen owns.
 *
 * How a session state change reaches the glue Lua: `ProtocolSession#on` is the one hook this engine
 * has, and it is polled here for two EDGE-TRIGGERED transitions, matching the two events real
 * `interface/gluexml` files actually register for (grepped from the shipped glue Lua, not invented):
 *
 *  - `state.stage === LoginStage.CharacterList` fires `CHARACTER_LIST_UPDATE` -- `characterselect.lua`
 *    registers exactly this name and reacts by calling `UpdateCharacterList()`. `refreshCharacters` is
 *    the ONLY code path that assigns this stage, so firing on every notify where the stage reads
 *    `CharacterList` fires once per roster refresh (initial join, and again after every create/delete)
 *    and never spuriously in between.
 *  - `state.stage === LoginStage.Offline`, coming from a stage that means "a world connection was
 *    live" (`CharacterList`/`EnteringWorld`/`InWorld`), with no refusal standing, fires
 *    `DISCONNECTED_FROM_SERVER` -- `glueparent.lua` registers this name and reacts by returning to the
 *    login screen. A refusal is excluded because that path is a LOGIN failure the login screen already
 *    renders from `session.lastRefusal` directly; this event is for a session that WAS connected and
 *    dropped, not one that never got in.
 *
 *  KNOWN GAP, not closed here: `onWorldDisconnect` (session.ts) can also land on `RealmList` rather
 *  than `Offline` when a session key still stands (the reconnect-friendly branch). That case fires
 *  `OPEN_REALM_LIST` (see `realms.ts`) but not `DISCONNECTED_FROM_SERVER`, because nothing exposed on
 *  `SessionState` distinguishes "arrived at RealmList after a disconnect" from "arrived at RealmList
 *  after a normal login" -- both are simply `stage === RealmList`. The player still lands on a screen
 *  that works; they just do not see the "disconnected" dialog for that specific branch.
 */
import { LuaVM } from '../vm';
import { fireEvent } from '../events';
import { ProtocolSession } from '../../../../../network/protocol/session';
import { LoginStage } from '../../../../../network/protocol/stages';
import { ConnectionSettings, loadSettings, saveSettings } from '../../../../../network/protocol/connection-settings';

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Persistence `GetSavedAccountName`/`SetSavedAccountName`/`GetSavedAccountList`/`GetUsesToken` read and write. */
export interface SavedAccountStore {
  getSavedAccountName(): string;
  setSavedAccountName(value: string): void;
  getSavedAccountList(): string;
  setSavedAccountList(value: string): void;
  getUsesToken(): boolean;
  setUsesToken(value: boolean): void;
}

/** `wow.accountlogin.extra` -- the fields `ConnectionSettings` has no slot for (that type only owns `savedAccount`). */
const EXTRA_KEY = 'wow.accountlogin.extra';
type ExtraSettings = { savedAccountList: string; usesToken: boolean };
const EXTRA_DEFAULTS: ExtraSettings = { savedAccountList: '', usesToken: false };

function loadExtra(storage: Storage | null): ExtraSettings {
  try {
    const raw = storage?.getItem(EXTRA_KEY);
    if (!raw) {
      return EXTRA_DEFAULTS;
    }
    return { ...EXTRA_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return EXTRA_DEFAULTS;
  }
}

function saveExtra(storage: Storage | null, extra: ExtraSettings): void {
  try {
    storage?.setItem(EXTRA_KEY, JSON.stringify(extra));
  } catch {
    // Unsaved is a lost preference, not a failure worth surfacing.
  }
}

/**
 * The sanctioned store: `savedAccount` goes through `connection-settings.ts`'s own
 * `loadSettings`/`saveSettings` (the same persistence the login screen's address field already uses,
 * already covered by `connection-settings.test.ts`), and the two fields that type has no room for get
 * a sibling key under the same storage.
 */
export function defaultSavedAccountStore(storage: Storage | null = defaultStorage()): SavedAccountStore {
  const patchSettings = (patch: Partial<ConnectionSettings>): void => {
    saveSettings({ ...loadSettings(storage), ...patch }, storage);
  };
  return {
    getSavedAccountName: () => loadSettings(storage).savedAccount ?? '',
    setSavedAccountName: (value) => patchSettings({ savedAccount: value }),
    getSavedAccountList: () => loadExtra(storage).savedAccountList,
    setSavedAccountList: (value) => saveExtra(storage, { ...loadExtra(storage), savedAccountList: value }),
    getUsesToken: () => loadExtra(storage).usesToken,
    setUsesToken: (value) => saveExtra(storage, { ...loadExtra(storage), usesToken: value }),
  };
}

const CONNECTED_STAGES = new Set([LoginStage.CharacterList, LoginStage.EnteringWorld, LoginStage.InWorld]);

/**
 * Installs the login/session globals on `vm`, wired to `session`. Returns the unsubscribe from
 * `session.on`, for a screen teardown that must not keep firing events into a dead VM.
 */
export function installLoginApi(
  vm: LuaVM,
  session: ProtocolSession,
  store: SavedAccountStore = defaultSavedAccountStore(),
): () => void {
  let prevStage = session.stage;
  const unsubscribe = session.on((state) => {
    if (state.stage === LoginStage.CharacterList) {
      fireEvent(vm, 'CHARACTER_LIST_UPDATE');
    }
    if (state.stage === LoginStage.Offline && state.refusal === null && CONNECTED_STAGES.has(prevStage)) {
      fireEvent(vm, 'DISCONNECTED_FROM_SERVER', [0]);
    }
    prevStage = state.stage;
  });

  // AccountLogin_Login: the account/password the player typed, straight to the session.
  vm.registerFunction('DefaultServerLogin', (args) => {
    const account = String(args[0] ?? '');
    const password = String(args[1] ?? '');
    void session.login(account, password);
    return [];
  });

  // TokenEntry_Cancel / the CONNECTING dialog's Cancel button.
  vm.registerFunction('CancelLogin', () => {
    session.cancelLogin();
    return [];
  });

  // GlueParent's own exit-to-login path (CharacterSelect's "Disconnect", or an explicit log-out).
  // `ProtocolSession` has no separate "tear down but stay logged in" call; `cancelLogin` is the one
  // operation that drops the world connection's standing and returns to `Offline`.
  vm.registerFunction('DisconnectFromServer', () => {
    session.cancelLogin();
    return [];
  });

  vm.registerFunction('GetSavedAccountName', () => [store.getSavedAccountName()]);
  vm.registerFunction('SetSavedAccountName', (args) => {
    store.setSavedAccountName(String(args[0] ?? ''));
    return [];
  });
  vm.registerFunction('GetSavedAccountList', () => [store.getSavedAccountList()]);
  vm.registerFunction('SetSavedAccountList', (args) => {
    store.setSavedAccountList(String(args[0] ?? ''));
    return [];
  });
  vm.registerFunction('GetUsesToken', () => [store.getUsesToken()]);
  vm.registerFunction('SetUsesToken', (args) => {
    store.setUsesToken(Boolean(args[0]));
    return [];
  });

  return unsubscribe;
}
