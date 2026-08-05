/**
 * The two decisions the realm list makes that are not layout: what order the rows come in, and what
 * each row's type and population columns say. Both pure -- no canvas, no session.
 */
import { RealmInfo } from '../../../../network/protocol/types';
import {
  BLUE_FONT_COLOR,
  GRAY_FONT_COLOR,
  GREEN_FONT_COLOR,
  NORMAL_FONT_COLOR,
  RED_FONT_COLOR,
  nextRealmSort,
  realmDisplay,
  realmLoadLabel,
  realmTypeLabel,
  sortRealms,
} from '../realm-list-state';

function realm(over: Partial<RealmInfo>): RealmInfo {
  return {
    id: 1,
    name: 'Realm',
    host: 'logon.example.com',
    port: 8085,
    population: 0,
    characterCount: 0,
    online: true,
    recommended: false,
    pvp: false,
    rp: false,
    locked: false,
    invalid: false,
    ...over,
  };
}

describe('the column sort', () => {
  const realms = [
    realm({ name: 'Blackrock', pvp: true, characterCount: 2, population: 1.5 }),
    realm({ name: 'Aerie Peak', pvp: false, characterCount: 0, population: -1 }),
    realm({ name: 'Chromie', pvp: true, characterCount: 5, population: 0 }),
  ];

  const names = (list: RealmInfo[]): string[] => list.map((entry) => entry.name);

  it('orders by each column and reverses when the same header is clicked again', () => {
    expect(names(sortRealms(realms, { column: 'name', descending: false }))).toEqual([
      'Aerie Peak',
      'Blackrock',
      'Chromie',
    ]);
    // `mode`: normal realms before PvP ones, name breaking the tie.
    expect(names(sortRealms(realms, { column: 'mode', descending: false }))).toEqual([
      'Aerie Peak',
      'Blackrock',
      'Chromie',
    ]);
    expect(names(sortRealms(realms, { column: 'characters', descending: false }))).toEqual([
      'Aerie Peak',
      'Blackrock',
      'Chromie',
    ]);
    expect(names(sortRealms(realms, { column: 'load', descending: false }))).toEqual([
      'Aerie Peak',
      'Chromie',
      'Blackrock',
    ]);

    // Clicking the active header reverses; clicking a different one starts ascending.
    const first = nextRealmSort({ column: 'name', descending: false }, 'load');
    expect(first).toEqual({ column: 'load', descending: false });
    const second = nextRealmSort(first, 'load');
    expect(second).toEqual({ column: 'load', descending: true });
    expect(names(sortRealms(realms, second))).toEqual(['Blackrock', 'Chromie', 'Aerie Peak']);

    // Non-mutating: the caller's array keeps its own order.
    expect(names(realms)).toEqual(['Blackrock', 'Aerie Peak', 'Chromie']);
  });
});

describe('the type and population columns', () => {
  it('says what realmlist.lua says, in the colours it sets', () => {
    // Type (realmlist.lua:53-65). `rp` is not on our wire, so those two branches are driven here
    // through `RealmDisplay` directly -- see the type's own comment.
    const base = realmDisplay(realm({}));
    expect(realmTypeLabel({ ...base, pvp: true, rp: true })).toEqual({
      stringKey: 'RPPVP_PARENTHESES',
      color: NORMAL_FONT_COLOR,
    });
    expect(realmTypeLabel({ ...base, rp: true })).toEqual({
      stringKey: 'RP_PARENTHESES',
      color: GREEN_FONT_COLOR,
    });
    expect(realmTypeLabel(realmDisplay(realm({ pvp: true })))).toEqual({
      stringKey: 'PVP_PARENTHESES',
      color: RED_FONT_COLOR,
    });
    expect(realmTypeLabel(realmDisplay(realm({})))).toEqual({
      stringKey: 'GAMETYPE_NORMAL',
      color: NORMAL_FONT_COLOR,
    });

    // Population, in the client's own branch order (realmlist.lua:70-95). An offline realm outranks
    // everything, and the -3/-2/2 sentinels outrank the `> 0` / `< 0` tests they would fall into.
    expect(realmLoadLabel(realmDisplay(realm({ online: false, population: 1 })))).toEqual({
      stringKey: 'REALM_DOWN',
      color: GRAY_FONT_COLOR,
    });
    expect(realmLoadLabel({ ...base, locked: true })).toEqual({
      stringKey: 'REALM_LOCKED',
      color: RED_FONT_COLOR,
    });
    expect(realmLoadLabel(realmDisplay(realm({ recommended: true })))).toEqual({
      stringKey: 'LOAD_RECOMMENDED',
      color: BLUE_FONT_COLOR,
    });
    expect(realmLoadLabel(realmDisplay(realm({ population: -2 })))).toEqual({
      stringKey: 'LOAD_NEW',
      color: GREEN_FONT_COLOR,
    });
    expect(realmLoadLabel(realmDisplay(realm({ population: 2 })))).toEqual({
      stringKey: 'LOAD_FULL',
      color: RED_FONT_COLOR,
    });
    expect(realmLoadLabel(realmDisplay(realm({ population: 1.5 })))).toEqual({
      stringKey: 'LOAD_HIGH',
      color: RED_FONT_COLOR,
    });
    expect(realmLoadLabel(realmDisplay(realm({ population: -1 })))).toEqual({
      stringKey: 'LOAD_LOW',
      color: GREEN_FONT_COLOR,
    });
    expect(realmLoadLabel(realmDisplay(realm({ population: 0 })))).toEqual({
      stringKey: 'LOAD_MEDIUM',
      color: NORMAL_FONT_COLOR,
    });
  });
});
