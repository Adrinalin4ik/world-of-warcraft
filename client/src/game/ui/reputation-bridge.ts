/**
 * THE REPUTATION TAB'S ENGINE GLOBALS -- the six that `api/units.ts` declared as gaps.
 *
 * The wire half is `network/game/object/reputation.ts`; the DBC half is
 * `pipeline/dbc/faction-data.ts`. This file is the join the client's own Lua reads.
 *
 * ## The contract, read off the client's own destructuring
 *
 *     name, description, standingID, barMin, barMax, barValue, atWarWith, canToggleAtWar,
 *     isHeader, isCollapsed, hasRep, isWatched, isChild = GetFactionInfo(factionIndex)
 *
 * (`reputationframe.lua:158` and again at `:278`.) Thirteen returns, in that order.
 *
 * **`standingID` IS 1-BASED, and this is the off-by-one that would produce a plausible wrong screen
 * rather than an error.** The pane uses it two ways -- `FACTION_BAR_COLORS[standingID]` and
 * `GetText("FACTION_STANDING_LABEL"..standingID)` (`:177-179`) -- and both tables are written 1..8 for
 * Hated..Exalted. A 0-based id would colour every faction one band low and label it one band low, with
 * nothing raising.
 *
 * **The bar values are ABSOLUTE thresholds, not a normalised 0..1.** `ReputationFrame_Update` normalises
 * them itself immediately after the call: `barMax = barMax - barMin; barValue = barValue - barMin;
 * barMin = 0` (`:171-174`). Returning pre-normalised values would show every faction at the wrong fill.
 *
 * ## The thresholds are SERVER-SOURCED and carry that label
 *
 * No served DBC holds the reputation band boundaries -- `Faction.dbc` has `reputationBase[4]` (a starting
 * value per race group) and nothing about the bands. The eight bands below are TrinityCore's
 * `ReputationRank`/`ReputationMgr` values for 3.3.5, the same source as the packet layout. The one
 * internal check available: they are contiguous and the last band's top (42999) is one below the 43000
 * ceiling the server clamps to, which is what makes Exalted a 1000-wide band rather than an open one.
 *
 * ## Cost
 *
 * One `UPDATE_FACTION` event per reputation packet that actually changed something (the handler bumps a
 * revision and only announces on a real change), and the pane's own handler returns early when it is not
 * shown. The row list is rebuilt on demand and memoised against the handler revision plus the collapsed
 * set, so `ReputationFrame_Update`'s loop over its 20 visible rows costs one array index per row rather
 * than a DBC walk. No per-frame work; the interface draw-list fingerprint is untouched.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import { factionData, FactionDisplayRow } from '../pipeline/dbc/faction-data';
import {
  FACTION_FLAG_AT_WAR,
  FACTION_FLAG_HIDDEN,
  FACTION_FLAG_INACTIVE,
  FACTION_FLAG_INVISIBLE_FORCED,
  FACTION_FLAG_PEACE_FORCED,
  FACTION_FLAG_VISIBLE,
  FactionStanding,
} from '../../network/game/object/reputation';

/**
 * The eight reputation bands, as `[standingID, floor]` with the floor inclusive.
 *
 * SERVER-SOURCED -- see the file header. `standingID` is the 1-based value the pane's own tables are
 * keyed by, so it is stored rather than derived from the array position, which is what stops a later
 * reorder from silently shifting every label.
 */
const BANDS: Array<{ standingID: number; floor: number; ceiling: number }> = [
  { standingID: 1, floor: -42000, ceiling: -6000 }, // Hated
  { standingID: 2, floor: -6000, ceiling: -3000 }, // Hostile
  { standingID: 3, floor: -3000, ceiling: 0 }, // Unfriendly
  { standingID: 4, floor: 0, ceiling: 3000 }, // Neutral
  { standingID: 5, floor: 3000, ceiling: 9000 }, // Friendly
  { standingID: 6, floor: 9000, ceiling: 21000 }, // Honored
  { standingID: 7, floor: 21000, ceiling: 42000 }, // Revered
  { standingID: 8, floor: 42000, ceiling: 43000 }, // Exalted
];

/** The band a raw standing falls in. Clamped at both ends rather than answering nothing. */
function bandFor(standing: number): { standingID: number; floor: number; ceiling: number } {
  for (const band of BANDS) {
    if (standing < band.ceiling) {
      return band;
    }
  }
  return BANDS[BANDS.length - 1];
}

export function attachReputationBridge(vm: LuaVM, world: World): () => void {
  /**
   * Which headers are COLLAPSED. Engine state, exactly as `skills-bridge.ts` holds it: nothing in the
   * manifest stores it and `CollapseFactionHeader`/`ExpandFactionHeader` are the only writers.
   *
   * Collapsed rather than expanded is the set held because expanded is the default.
   */
  const collapsed = new Set<number>();

  /** `SetWatchedFactionIndex`'s value: the faction on the XP bar. 0 is none. */
  let watched = 0;

  let cached: FactionDisplayRow[] = [];
  let cachedAt = -1;
  let cachedCollapsed = -1;

  const handler = (): { all(): Map<number, FactionStanding>; version: number } | null => {
    const objects = (world as unknown as { game?: { objectHandler?: { reputationHandler?: unknown } } })
      .game?.objectHandler?.reputationHandler;
    return (objects as { all(): Map<number, FactionStanding>; version: number }) ?? null;
  };

  const standings = (): Map<number, FactionStanding> => handler()?.all() ?? new Map();

  /** `FACTION_FLAG_VISIBLE`, minus the two bits that force a row off the pane whatever else is set. */
  const isVisible = (index: number): boolean => {
    const entry = standings().get(index);
    if (entry === undefined) {
      return false;
    }
    if ((entry.flags & (FACTION_FLAG_HIDDEN | FACTION_FLAG_INVISIBLE_FORCED)) !== 0) {
      return false;
    }
    return (entry.flags & FACTION_FLAG_VISIBLE) !== 0;
  };

  /**
   * The flat row list, memoised against the handler revision AND the collapsed set.
   *
   * Both are needed: a standing arriving changes which rows are visible, and collapsing a header changes
   * which rows are listed at all. `collapsed.size` is not a sufficient key on its own -- collapsing one
   * header and expanding another in the same frame keeps the size -- so a counter is bumped instead.
   */
  let collapsedRevision = 0;
  const rows = (): FactionDisplayRow[] => {
    if (!factionData.loaded) {
      return [];
    }
    const version = handler()?.version ?? -1;
    if (cachedAt === version && cachedCollapsed === collapsedRevision) {
      return cached;
    }
    const all = factionData.displayRows(isVisible);
    // Drop the descendants of a collapsed header. Done here rather than in the DBC module so that
    // module stays a pure join with no UI state.
        const out: FactionDisplayRow[] = [];
    let skipUnder: number | null = null;
    for (const entry of all) {
      if (skipUnder !== null) {
        if (entry.row.parentId === skipUnder) {
          continue;
        }
        skipUnder = null;
      }
      out.push(entry);
      if (entry.isHeader && collapsed.has(entry.row.id)) {
        skipUnder = entry.row.id;
      }
    }
    cached = out;
    cachedAt = version;
    cachedCollapsed = collapsedRevision;
    return out;
  };

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  fn('GetNumFactions', () => [rows().length]);

  /**
   * `GetFactionInfo(index)` -> the thirteen returns above.
   *
   * An out-of-range index answers nothing, which is what the pane's own
   * `factionIndex <= numFactions` guard already prevents -- but `ReputationFrame_OnEvent` can fire
   * between a standing landing and the scroll frame updating, so the guard is here too rather than
   * raising on an undefined row.
   */
  fn('GetFactionInfo', (args) => {
    const entry = rows()[Number(args[0]) - 1];
    if (entry === undefined) {
      return [];
    }
    const state = entry.row.index >= 0 ? standings().get(entry.row.index) : undefined;
    const standing = state?.standing ?? 0;
    const band = bandFor(standing);
    const flags = state?.flags ?? 0;
    // `hasRep` is whether this row has a reputation of its OWN. A header usually does not, and the pane
    // hides its bar when it does not -- so this must not be forced true for a header that happens to
    // carry a reputationIndex (`Horde` and `Alliance` both do).
    const hasRep = state !== undefined;
    return [
      entry.row.name,
      entry.row.description,
      band.standingID,
      band.floor,
      band.ceiling,
      standing,
      (flags & FACTION_FLAG_AT_WAR) !== 0,
      // `canToggleAtWar`: the server forbids it outright with PEACE_FORCED, and a faction with no
      // standing of its own has nothing to declare war on.
      hasRep && (flags & FACTION_FLAG_PEACE_FORCED) === 0,
      entry.isHeader,
      entry.isHeader && collapsed.has(entry.row.id),
      hasRep,
      watched !== 0 && watched === entry.row.index,
      entry.isChild,
    ];
  });

  /**
   * `GetWatchedFactionInfo()` -> `name, reaction, min, max, value` (`reputationframe.lua:324`).
   *
   * FIVE returns and a different shape from `GetFactionInfo` -- `reaction` is the standingID and the
   * three numbers are absolute, the same as the bar triple above. Answers nothing when no faction is
   * watched, which is what `MainMenuBar_UpdateExperienceBars` tests for before showing the rep bar.
   */
  fn('GetWatchedFactionInfo', () => {
    if (watched === 0) {
      return [];
    }
    const entry = rows().find((candidate) => candidate.row.index === watched);
    const state = standings().get(watched);
    if (entry === undefined || state === undefined) {
      return [];
    }
    const band = bandFor(state.standing);
    return [entry.row.name, band.standingID, band.floor, band.ceiling, state.standing];
  });

  /**
   * `SetWatchedFactionIndex(index)` -- the pane passes its own ROW index, not a reputationIndex, so it
   * is translated here. 0 clears it, which is how the client turns the rep bar off.
   */
  fn('SetWatchedFactionIndex', (args) => {
    const rowIndex = Number(args[0]);
    if (!Number.isFinite(rowIndex) || rowIndex <= 0) {
      watched = 0;
    } else {
      watched = rows()[rowIndex - 1]?.row.index ?? 0;
    }
    fireEvent(vm, 'UPDATE_FACTION');
    return [];
  });

  const setCollapsed = (args: unknown[], value: boolean): unknown[] => {
    const entry = rows()[Number(args[0]) - 1];
    if (entry === undefined || !entry.isHeader) {
      return [];
    }
    if (value) {
      collapsed.add(entry.row.id);
    } else {
      collapsed.delete(entry.row.id);
    }
    collapsedRevision += 1;
    fireEvent(vm, 'UPDATE_FACTION');
    return [];
  };

  fn('CollapseFactionHeader', (args) => setCollapsed(args, true));
  fn('ExpandFactionHeader', (args) => setCollapsed(args, false));

  /**
   * `FACTION_INACTIVE` is the one flag the pane reads that has no global of its own in 3.3.5a -- it is
   * exposed through `IsFactionInactive`, which `ReputationBar_OnClick`'s menu uses. Registered because
   * the wire carries the bit and the menu raises without it.
   */
  fn('IsFactionInactive', (args) => {
    const entry = rows()[Number(args[0]) - 1];
    if (entry === undefined) {
      return [false];
    }
    const state = entry.row.index >= 0 ? standings().get(entry.row.index) : undefined;
    return [((state?.flags ?? 0) & FACTION_FLAG_INACTIVE) !== 0];
  });

  // The DBC is kicked here rather than awaited: every global above answers an empty list until it lands,
  // and the pane redraws on `UPDATE_FACTION`. Same treatment `raceClassData` gets in `world-runtime.ts`.
  void factionData.ensureLoaded().then(() => {
    cachedAt = -1;
    fireEvent(vm, 'UPDATE_FACTION');
  });

  const onChange = (): void => {
    cachedAt = -1;
    fireEvent(vm, 'UPDATE_FACTION');
  };
  const game = (world as unknown as { game?: { on(e: string, f: () => void): void;
    off?(e: string, f: () => void): void; removeListener?(e: string, f: () => void): void } }).game;
  game?.on('reputation:change', onChange);

  return () => {
    if (game?.off) {
      game.off('reputation:change', onChange);
    } else if (game?.removeListener) {
      game.removeListener('reputation:change', onChange);
    }
  };
}
