/**
 * The RealmList screen's engine surface: `GetNumRealms`/`GetRealmInfo`/`ChangeRealm`/`GetServerName`,
 * backed by `ProtocolSession#realms` and `#chooseRealm`.
 *
 * `OPEN_REALM_LIST` is the event `realmlist.lua` actually registers (`RealmList_OnLoad`) and reacts to
 * by calling `RealmListUpdate()`, which is what re-reads `GetNumRealms`/`GetRealmInfo` -- grepped from
 * the shipped glue Lua, not the `RealmListUpdated` name the task brief guessed at (there is no such
 * event registered anywhere in the reference; see the task report for the correction). It fires
 * whenever the session's stage reads `RealmList`, which is the ONLY stage `attemptLogin` (a fresh
 * login) and `onWorldDisconnect` (a dropped world connection, session key still standing) ever put the
 * session into -- both are "the realm list is the screen to show, and it may have just changed."
 *
 * This client models realms as one flat list with no tournament/region categories, so `category` is
 * always `1` and `GetRealmCategories` always answers with exactly one name -- which is also what makes
 * `RealmList_UpdateTabs` hide its own tab row (`numTabs == 1`), the same as the real client on a server
 * with no additional realm categories configured.
 */
import { LuaVM } from '../vm';
import { fireEvent } from '../events';
import { ProtocolSession } from '../../../../../network/protocol/session';
import { LoginStage } from '../../../../../network/protocol/stages';
import { RealmInfo } from '../../../../../network/protocol/types';
// The same pure ordering rules the transcription drives its own header buttons from -- IMPORTED, not
// restated, for the reason `api/login.ts` imports `loginDialog`: if the two screens each carried their
// own comparator they could disagree about what a column header means, and the transcription is the
// oracle this one is compared against.
import {
  DEFAULT_REALM_SORT,
  RealmSort,
  RealmSortColumn,
  nextRealmSort,
  sortRealms,
} from '../../../screens/realm-list-state';

/** RealmList_OnUpdate's poll interval for `RequestRealmList()`, in seconds -- ours; not on the wire. */
const REFRESH_RATE_SECONDS = 5;

/** The realm-type byte `button.type` receives (realmlist.lua:98-102): 0 normal, 1 PvP, 6 RP, 8 RP-PvP. */
function realmTypeByte(realm: RealmInfo): number {
  if (realm.pvp && realm.rp) {
    return 8;
  }
  if (realm.rp) {
    return 6;
  }
  if (realm.pvp) {
    return 1;
  }
  return 0;
}

/** Installs the realm-list globals on `vm`, wired to `session`. Returns the `session.on` unsubscribe. */
export function installRealmsApi(vm: LuaVM, session: ProtocolSession): () => void {
  // `RealmList.selectedCategory` in the reference is a Lua-side field the tab click sets directly
  // (`RealmListTab_OnClick`); this client has one category and no setter in the engine API surface
  // (there is no `SetSelectedCategory` in the "must work" list), so this always reads back `1`.
  const selectedCategory = 1;
  // Set only by `ChangeRealm` below -- the realm the player is joined to (or joining), for
  // `GetServerName`. Not part of `SessionState`: the session tracks credentials and a session key, not
  // which `RealmInfo` was chosen.
  let currentRealm: RealmInfo | null = null;
  // The order the list is PRESENTED in, which is the engine's business and not the session's:
  // `ProtocolSession#realms` hands out a fresh copy in realmd's own order every time it is read, and
  // that is the order a freshly-shown list uses (`DEFAULT_REALM_SORT` is null). `SortRealms` moves this.
  let sort: RealmSort | null = DEFAULT_REALM_SORT;

  /**
   * The realms as the screen sees them: one ordered view, so `GetNumRealms`, `GetRealmInfo` and
   * `ChangeRealm` cannot disagree about what index 1 means.
   *
   * That agreement is the reason this is a function rather than three separate reads. The realm buttons
   * are `SetID(realmIndex)`d from the loop in `RealmListUpdate`, and `RealmList_OnOk` feeds that same id
   * straight to `ChangeRealm` (realmlist.lua:134,266) -- so an index resolved against a differently
   * ordered array would join a realm the player did not click.
   */
  const ordered = (): RealmInfo[] => sortRealms(session.realms, sort);

  const unsubscribe = session.on((state) => {
    if (state.stage === LoginStage.RealmList) {
      fireEvent(vm, 'OPEN_REALM_LIST');
    }
  });

  vm.registerFunction('RequestRealmList', () => {
    // RealmList_OnUpdate's refresh timer. `ProtocolSession` has no standalone "re-fetch realms" call
    // (a fetch only happens as part of `login`), so the honest bridge is to re-announce the realms the
    // session already holds -- the same event `GetNumRealms`/`GetRealmInfo` below read from live.
    fireEvent(vm, 'OPEN_REALM_LIST');
    return [];
  });

  // RealmList_OnHide: nothing asynchronous is in flight to cancel.
  vm.registerFunction('CancelRealmListQuery', () => []);

  vm.registerFunction('GetRealmCategories', () => ['Realms']);

  vm.registerFunction('GetSelectedCategory', () => [selectedCategory]);

  vm.registerFunction('GetNumRealms', (args) => {
    const category = Number(args[0] ?? selectedCategory);
    return [category === selectedCategory ? session.realms.length : 0];
  });

  /**
   * The four column headers' `SortRealms("name"|"mode"|"characters"|"load")` (realmlist.xml:377-449).
   *
   * REAL, not a stub, and it has to be: this is the engine's own function with no Lua behind it, so an
   * absent global is a nil-call the moment the player clicks a header -- the one control on this screen
   * that would otherwise take the whole handler down. Ordering IS the engine's job here, which is why the
   * order lives in this module and not in the session: `ProtocolSession#realms` is a getter returning a
   * fresh copy, so there is nothing there to sort, and reaching in to give it a mutable order would put a
   * presentation decision behind the wire decoder.
   *
   * Re-announcing through `OPEN_REALM_LIST` rather than calling `RealmListUpdate()` directly: the event
   * is the one door the client's own Lua opens this screen by, and `RealmList_OnEvent` already routes it
   * to `RealmListUpdate` when the frame is shown.
   */
  vm.registerFunction('SortRealms', (args) => {
    const column = String(args[0] ?? '') as RealmSortColumn;
    if (!['name', 'mode', 'characters', 'load'].includes(column)) {
      return [];
    }
    sort = nextRealmSort(sort, column);
    fireEvent(vm, 'OPEN_REALM_LIST');
    return [];
  });

  vm.registerFunction('GetRealmInfo', (args) => {
    const category = Number(args[0] ?? selectedCategory);
    const index = Number(args[1] ?? 0);
    if (category !== selectedCategory) {
      return [];
    }
    const realm = ordered()[index - 1];
    if (!realm) {
      return [];
    }
    // realmlist.lua:47 -- the exact tuple this is destructured into:
    //   name, numCharacters, invalidRealm, realmDown, currentRealm, pvp, rp, load, locked,
    //   major, minor, revision, build, type
    //
    // `currentRealm` is `1`/nil, NOT a boolean, and that is not a style choice: realmlist.lua:179 tests
    // `if ( currentRealm == 1 )`, and `true == 1` is false in Lua. A boolean there meant the realm the
    // player is already joined to could never be pre-highlighted. Every OTHER flag in this tuple is only
    // ever fed to a truthiness test, so those stay booleans.
    return [
      realm.name,
      realm.characterCount,
      realm.invalid,
      !realm.online,
      currentRealm?.id === realm.id ? 1 : null,
      realm.pvp,
      realm.rp,
      realm.recommended ? -3 : realm.population,
      realm.locked,
      realm.build?.major ?? null,
      realm.build?.minor ?? null,
      realm.build?.patch ?? null,
      realm.build?.build ?? null,
      realmTypeByte(realm),
    ];
  });

  vm.registerFunction('ChangeRealm', (args) => {
    const category = Number(args[0] ?? selectedCategory);
    const index = Number(args[1] ?? 0);
    if (category === selectedCategory) {
      const realm = ordered()[index - 1];
      if (realm) {
        currentRealm = realm;
        void session.chooseRealm(realm);
      }
    }
    return [];
  });

  vm.registerFunction('GetServerName', () => {
    if (!currentRealm) {
      return [];
    }
    return [currentRealm.name, currentRealm.pvp, currentRealm.rp, !currentRealm.online];
  });

  vm.registerFunction('RealmListUpdateRate', () => [REFRESH_RATE_SECONDS]);

  return unsubscribe;
}
