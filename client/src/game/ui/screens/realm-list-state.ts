/**
 * What the realm list SAYS about each realm, and what the column headers do to its order.
 *
 * Pure, and separate from the layout for the same reason `login-state.ts` is: this is the part with
 * actual rules -- the branch order in `RealmListUpdate` (realmlist.lua:41-131) is load-bearing, and
 * the colours are part of the meaning, not decoration.
 *
 * Returns string KEYS, never wording. `GlueStrings` resolves them at draw time so the player reads
 * the client's own words.
 */
import { RealmInfo } from '../../../network/protocol/types';

/**
 * FrameXML's font-colour table -- and it is not FrameXML's file we read it from: the glue layer
 * declares its own copy in the `<Script>` block at the top of `gluefontstyles.xml:4-9`, which is
 * the one `realmlist.lua` sees. Verbatim:
 *
 *   NORMAL_FONT_COLOR    = 1.0,  0.82,  0     -> #ffd100
 *   HIGHLIGHT_FONT_COLOR = 1.0,  1.0,   1.0   -> #ffffff
 *   GRAY_FONT_COLOR      = 0.5,  0.5,   0.5   -> #808080
 *   GREEN_FONT_COLOR     = 0.1,  1.0,   0.1   -> #1aff1a
 *   RED_FONT_COLOR       = 1.0,  0.1,   0.1   -> #ff1a1a
 *   BLUE_FONT_COLOR      = 0,    0.749, 0.953 -> #00bff3
 *
 * Note `NORMAL_FONT_COLOR` (#ffd100) is NOT `GlueFontNormal`'s own #ffc700: the type and population
 * columns are recoloured from this table by `SetTextColor`, so they really do differ from the rest of
 * the screen by two shades of gold. That is the client's, not a slip.
 */
export const NORMAL_FONT_COLOR = '#ffd100';
export const HIGHLIGHT_FONT_COLOR = '#ffffff';
export const GRAY_FONT_COLOR = '#808080';
export const GREEN_FONT_COLOR = '#1aff1a';
export const RED_FONT_COLOR = '#ff1a1a';
export const BLUE_FONT_COLOR = '#00bff3';

/** A column's text plus the colour the client sets on it. */
export type RealmLabel = { stringKey: string; color: string };

/**
 * The fields `RealmListUpdate` branches on, as `GetRealmInfo` hands them over
 * (realmlist.lua:47). Spelled out as its own type because THREE of them are not on the wire we
 * decode, and a mapping written straight against `RealmInfo` would hide that:
 *
 *  - `locked` -- realmd sends it as the second byte of every realm record, and
 *    `decodeRealmList` (network/protocol/wotlk/logon-wire.ts:207) deliberately skips it
 *    (`at++; // lock`). Unreachable until that byte is kept. See the note in `realmDisplay`.
 *  - `rp` -- there is no RP bit in the 3.3.5 realm record at all; the realm TYPE arrives as the
 *    `icon` byte and the decoder maps only its PvP values (`REALM_TYPE_PVP`). So `RPPVP_PARENTHESES`
 *    and `RP_PARENTHESES` are unreachable, not omitted.
 *  - `invalid` -- realm flag 0x01 (version mismatch), not decoded either.
 *
 * The branches are written anyway: they are what the client does, they are what the two tests pin,
 * and the day the decoder carries those bits the screen is already right.
 */
export type RealmDisplay = {
  /** `realmDown`. */
  down: boolean;
  locked: boolean;
  rp: boolean;
  pvp: boolean;
  /** The client's `load`, whose -3/-2/2 values are sentinels rather than magnitudes. */
  load: number;
  /** `numCharacters`. */
  characters: number;
  invalid: boolean;
};

/**
 * `GetRealmInfo`'s tuple, as far as our wire reaches.
 *
 * `load` comes from `RealmInfo#population`, the realm record's population float. The client's -3.0
 * and -2.0 sentinels are not something the fetched client data explains -- they are produced below
 * `GetRealmInfo`, in the engine -- so `recommended` (realm flag 0x20, the one flag the decoder does
 * keep) is folded in here as -3.0, which is the value that means exactly what that flag means. OURS,
 * in the sense that the fold is not transcribed from a file; the MEANING is the client's.
 */
export function realmDisplay(realm: RealmInfo): RealmDisplay {
  return {
    down: !realm.online,
    locked: realm.locked,
    rp: realm.rp,
    pvp: realm.pvp,
    load: realm.recommended ? -3 : realm.population,
    characters: realm.characterCount,
    invalid: realm.invalid,
  };
}

/**
 * The type column (`$parentPVP`), realmlist.lua:53-65 -- pvp AND rp first, then rp, then pvp, then
 * the fallback, which is a WORD ("Normal") rather than a parenthesised tag.
 */
export function realmTypeLabel(realm: RealmDisplay): RealmLabel {
  if (realm.pvp && realm.rp) {
    return { stringKey: 'RPPVP_PARENTHESES', color: NORMAL_FONT_COLOR };
  }
  if (realm.rp) {
    return { stringKey: 'RP_PARENTHESES', color: GREEN_FONT_COLOR };
  }
  if (realm.pvp) {
    return { stringKey: 'PVP_PARENTHESES', color: RED_FONT_COLOR };
  }
  return { stringKey: 'GAMETYPE_NORMAL', color: NORMAL_FONT_COLOR };
}

/**
 * The population column (`$parentLoad`), realmlist.lua:70-95, in the client's own branch order.
 *
 * The three EQUALITY tests come before the two inequalities, and that ordering is the whole rule:
 * -3.0 and -2.0 are sentinels ("New Players", "New"), and 2.0 is "Full". Reordered, -3.0 would fall
 * into `load < 0` and read "Low", and 2.0 into `load > 0` and read "High".
 */
export function realmLoadLabel(realm: RealmDisplay): RealmLabel {
  if (realm.down) {
    return { stringKey: 'REALM_DOWN', color: GRAY_FONT_COLOR };
  }
  if (realm.locked) {
    return { stringKey: 'REALM_LOCKED', color: RED_FONT_COLOR };
  }
  if (realm.load === -3) {
    return { stringKey: 'LOAD_RECOMMENDED', color: BLUE_FONT_COLOR };
  }
  if (realm.load === -2) {
    return { stringKey: 'LOAD_NEW', color: GREEN_FONT_COLOR };
  }
  if (realm.load === 2) {
    return { stringKey: 'LOAD_FULL', color: RED_FONT_COLOR };
  }
  if (realm.load > 0) {
    return { stringKey: 'LOAD_HIGH', color: RED_FONT_COLOR };
  }
  if (realm.load < 0) {
    return { stringKey: 'LOAD_LOW', color: GREEN_FONT_COLOR };
  }
  return { stringKey: 'LOAD_MEDIUM', color: NORMAL_FONT_COLOR };
}

/**
 * The colour of the realm NAME, which varies per row -- `SetNormalFontObject` /
 * `SetHighlightFontObject` at realmlist.lua:114-131, resolved through `gluefontstyles.xml:28-45`:
 *
 *   realmDown       -> `RealmDownNormal`         0.5,0.5,0.5    highlight `RealmDownHighlight` 0.8
 *   invalidRealm    -> `RealmInvalidNormal`      1.0,0.1,0.1    highlight `RealmInvalidHighlight` 1,.5,.5
 *   characters > 0  -> `RealmCharactersNormal`   0.1,1.0,0.1    highlight `GlueFontHighlightLeft` white
 *   otherwise       -> `RealmNoCharactersNormal` 1.0,0.78,0.0   highlight `GlueFontHighlightLeft` white
 *
 * `highlighted` is the button's highlight font being in force: FrameXML draws that on hover, and
 * `RealmListUpdate` also calls `LockHighlight()` on the selected row (realmlist.lua:146), which
 * latches it. That is why the reference screenshot shows one name green and one white -- the white
 * one is the selected realm, not a differently-flagged one.
 */
export function realmNameColor(realm: RealmDisplay, highlighted: boolean): string {
  if (realm.down) {
    return highlighted ? '#cccccc' : GRAY_FONT_COLOR;
  }
  if (realm.invalid) {
    return highlighted ? '#ff8080' : RED_FONT_COLOR;
  }
  if (highlighted) {
    return HIGHLIGHT_FONT_COLOR;
  }
  return realm.characters > 0 ? GREEN_FONT_COLOR : '#ffc700';
}

/**
 * The selection highlight's vertex colour, realmlist.lua:165-173: red for an invalid realm, green
 * when the player has characters there, `GlueFontNormal`'s gold otherwise.
 */
export function realmHighlightColor(realm: RealmDisplay): string {
  if (realm.invalid) {
    return RED_FONT_COLOR;
  }
  return realm.characters > 0 ? GREEN_FONT_COLOR : '#ffc700';
}

/**
 * The row's own text: the name, with the advertised build appended --
 * `name.." ("..major.."."..minor.."."..revision..")"` (realmlist.lua:103). `RealmInfo#build` names
 * that third component `patch`; it is the same field.
 */
export function realmRowName(realm: RealmInfo): string {
  if (!realm.build) {
    return realm.name;
  }
  const { major, minor, patch } = realm.build;
  return `${realm.name} (${major}.${minor}.${patch})`;
}

/**
 * The character-count column (`$parentPlayers`), realmlist.lua:108-113: parenthesised when the
 * player has characters on that realm, and EMPTY rather than "(0)" when they do not.
 */
export function realmPlayersText(realm: RealmDisplay): string {
  return realm.characters > 0 ? `(${realm.characters})` : '';
}

/** The four column keys, spelled as the header buttons' `SortRealms(...)` calls (realmlist.xml). */
export type RealmSortColumn = 'name' | 'mode' | 'characters' | 'load';

export type RealmSort = { column: RealmSortColumn; descending: boolean };

/** Ascending by name, which is the order a fresh list reads best in. OURS: see `sortRealms`. */
export const DEFAULT_REALM_SORT: RealmSort = { column: 'name', descending: false };

/**
 * What clicking a column header does: sort by it, or reverse it if it is already the sort column.
 *
 * OURS. The header buttons call `SortRealms("name"|"mode"|"characters"|"load")`, which is an engine
 * function with no Lua behind it, so the client data says WHICH columns sort and nothing about how.
 * Click-again-to-reverse is the behaviour the sort arrow in `RealmSortButtonTemplate` implies and
 * what every other WoW column header does, but it is not transcribed from a file.
 */
export function nextRealmSort(current: RealmSort, column: RealmSortColumn): RealmSort {
  if (current.column === column) {
    return { column, descending: !current.descending };
  }
  return { column, descending: false };
}

/**
 * Order the list. OURS, like `nextRealmSort` -- the comparators are not in the client data.
 *
 * Non-mutating (the session hands out a fresh array, but a screen sorting its caller's array in
 * place is a trap regardless), and every comparator falls back to the name so the order is total:
 * three realms with no characters must not shuffle among themselves each time the list refreshes.
 */
export function sortRealms(realms: RealmInfo[], sort: RealmSort): RealmInfo[] {
  const byName = (a: RealmInfo, b: RealmInfo): number => a.name.localeCompare(b.name);

  const compare = (a: RealmInfo, b: RealmInfo): number => {
    switch (sort.column) {
      case 'name':
        return byName(a, b);
      case 'mode':
        // The type column's rank: PvP realms after normal ones, since that is the order the type
        // strings themselves read in ("Normal" then "(PVP)").
        return Number(a.pvp) - Number(b.pvp) || byName(a, b);
      case 'characters':
        return a.characterCount - b.characterCount || byName(a, b);
      case 'load':
        return a.population - b.population || byName(a, b);
    }
  };

  const sorted = [...realms].sort(compare);
  return sort.descending ? sorted.reverse() : sorted;
}
