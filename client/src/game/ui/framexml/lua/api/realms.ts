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

  vm.registerFunction('GetRealmInfo', (args) => {
    const category = Number(args[0] ?? selectedCategory);
    const index = Number(args[1] ?? 0);
    if (category !== selectedCategory) {
      return [];
    }
    const realm = session.realms[index - 1];
    if (!realm) {
      return [];
    }
    // realmlist.lua:47 -- the exact tuple this is destructured into:
    //   name, numCharacters, invalidRealm, realmDown, currentRealm, pvp, rp, load, locked,
    //   major, minor, revision, build, type
    return [
      realm.name,
      realm.characterCount,
      realm.invalid,
      !realm.online,
      currentRealm?.id === realm.id,
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
      const realm = session.realms[index - 1];
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
