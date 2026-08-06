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
import { loginDialog } from '../../../screens/login-state';

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
 * The three STATUS-DIALOG events, which are how the connecting dialog reaches the screen at all.
 *
 * This was diagnosed before it was written, because the obvious suspects were all innocent.
 * `AccountLogin_Login` (accountlogin.lua:170) does NOT show a dialog -- it plays a sound, calls
 * `DefaultServerLogin` and clears the password box. In the real client the "Connecting" panel is the
 * ENGINE's: it fires `OPEN_STATUS_DIALOG`, `GlueDialog_OnEvent` turns that into
 * `GlueDialog_Show(arg1, arg2)` (gluedialog.lua:663), and `CLOSE_STATUS_DIALOG` takes it away again.
 * `GlueDialog_OnLoad` registers all three. Nothing here fired any of them, so the dialog was never
 * asked to appear -- verified by driving `GlueDialog_Show("CANCEL", LOGIN_STATE_CONNECTING)` by hand in
 * the browser, which showed a correctly sized and captioned panel (`scratchpad/diag-dialog-byhand.png`).
 * So this is a missing TRIGGER, not a broken dialog, and in particular not the unsized-`<FontString>`
 * measurement gap: `GlueDialogText` is authored 450x0, `GlueDialogBackground` sizes to 512x80 from it,
 * and that is a visible panel.
 *
 * `loginDialog` (`screens/login-state.ts`) decides WHICH dialog is owed, and it is imported rather than
 * restated: it is the same pure function the transcription drives its own dialog from, so the two
 * screens cannot disagree about whether an in-flight attempt outranks a previous failure or whether a
 * refusal survives the return to `Offline`. What is new here is only the translation into the client's
 * own event vocabulary.
 *
 * EDGE-TRIGGERED on the dialog's identity, not fired per notify: `GlueDialog_Show` re-runs a dialog's
 * whole setup (and its `OnShow`), so re-firing on every session notify would restart it repeatedly.
 */
type DialogSignature = string;

/** The dialog type name `GlueDialogTypes` is keyed by, per kind (gluedialog.lua:162,185). */
const CONNECTING_DIALOG = 'CANCEL';
const ERROR_DIALOG = 'OKAY';

/**
 * A global string by name, or null. The client's own wording, never ours -- `LOGIN_STATE_CONNECTING`
 * and every refusal key live in `GlueStrings.lua`, which the manifest loads first for this reason.
 * A non-string global arrives as a handle and would pin a registry slot per read if discarded bare.
 */
function globalString(vm: LuaVM, name: string): string | null {
  const value = vm.getGlobal(name);
  if (typeof value === 'string') {
    return value;
  }
  if (vm.isRef(value)) {
    vm.unref(value);
  }
  return null;
}

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
  let dialogSignature: DialogSignature = 'none';
  const unsubscribe = session.on((state) => {
    if (state.stage === LoginStage.CharacterList) {
      fireEvent(vm, 'CHARACTER_LIST_UPDATE');
    }
    if (state.stage === LoginStage.Offline && state.refusal === null && CONNECTED_STAGES.has(prevStage)) {
      fireEvent(vm, 'DISCONNECTED_FROM_SERVER', [0]);
    }
    prevStage = state.stage;

    // The status dialog (see the note above `CONNECTING_DIALOG`).
    const dialog = loginDialog(state.stage, state.refusal, session.retrying);
    const signature = dialog.kind === 'error' ? `error:${dialog.stringKey}` : dialog.kind;
    if (signature === dialogSignature) {
      return;
    }
    dialogSignature = signature;
    if (dialog.kind === 'none') {
      fireEvent(vm, 'CLOSE_STATUS_DIALOG');
      return;
    }
    const which = dialog.kind === 'connecting' ? CONNECTING_DIALOG : ERROR_DIALOG;
    // `arg2` nil is legal and meaningful: `GlueDialog_Show` falls back to `dialogInfo.text` for it, so a
    // string this client's `GlueStrings.lua` does not define shows the dialog's own default rather than
    // the key as mojibake.
    const key = dialog.kind === 'connecting' ? 'LOGIN_STATE_CONNECTING' : dialog.stringKey;
    fireEvent(vm, 'OPEN_STATUS_DIALOG', [which, globalString(vm, key)]);
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

  // `GlueDialogTypes["CANCEL"].OnAccept` -- what the connecting dialog's one button does
  // (gluedialog.lua:167). `stubs.ts` registers this as a no-op for the case where no session is wired;
  // overriding it here (this installer runs after `installStubApi`) is what makes the button actually
  // abandon the attempt instead of only hiding the panel that reports it.
  vm.registerFunction('StatusDialogClick', () => {
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
