/**
 * `UnitReaction` -- how a unit feels about us -- resolved from `UNIT_FIELD_FACTIONTEMPLATE` through
 * `FactionTemplate.dbc`.
 *
 * This is the field that decides whether a target frame's health bar is red or green, and it is not
 * derivable from anything else the wire sends: the server ships a template ID and the CLIENT owns
 * the relation table. There is no `UNIT_FIELD_REACTION`.
 *
 * ## The table
 *
 * `wow-data-parser/dbc/entities/faction-template.js` decodes 3.3.5a's fourteen columns as
 * `id, factionID, <reserved flags>, groupMask, friendlyMask, hostileMask, relatedFactionIDs[8]`.
 * The trailing array is TWO arrays end to end -- `enemies[4]` then `friends[4]` -- which is why they
 * are split by index below rather than searched as one list. Getting that split wrong is silent: an
 * enemy id found in the friend half answers "friendly" for a mob that is about to bite you.
 *
 * ## The relation, verbatim
 *
 * The reference client's test, as preserved in the mangos family's `FactionTemplateEntry`:
 *
 *   IsHostileTo(other):  if both have a factionID -- enemies[] hit -> true, friends[] hit -> false;
 *                        then `hostileMask & other.groupMask`.
 *   IsFriendlyTo(other): same two lists first; then
 *                        `friendlyMask & other.groupMask || groupMask & other.friendlyMask`.
 *
 * The explicit id lists OUTRANK the masks, and hostility is asked FIRST -- a template can be in both
 * relations by mask (a neutral guard faction friendly to its own group and hostile to another it
 * shares a bit with), and the client resolves that as hostile.
 *
 * ## The 1..8 scale
 *
 * `UnitReaction` answers a REPUTATION standing, not a boolean: 1 hated, 2 hostile, 3 unfriendly,
 * 4 neutral, 5 friendly, 6 honored, 7 revered, 8 exalted. FrameXML compares against 4 (see
 * `lua/api/units.ts`), and `TargetFrame_CheckFaction` colours from `FACTION_BAR_COLORS[reaction]`.
 * A creature with no reputation faction can only be one of three of those, so this answers 2, 4 or 5
 * and says so rather than inventing a standing. Real reputation would need `SMSG_INITIALIZE_FACTIONS`
 * and the player's own standings, which this client does not read -- stated here rather than faked.
 */
import DBC from '../pipeline/dbc';

/** Hostile. `FACTION_BAR_COLORS[2]` is the red a hostile target frame is drawn in. */
export const REACTION_HOSTILE = 2;
/** Neutral -- the value every comparison in FrameXML is written around. */
export const REACTION_NEUTRAL = 4;
/** Friendly. */
export const REACTION_FRIENDLY = 5;

interface FactionTemplateRow {
  id: number;
  factionID: number;
  groupMask: number;
  friendlyMask: number;
  hostileMask: number;
  relatedFactionIDs: number[];
}

/** id -> row. Empty until the DBC lands; see `primeFactionTemplates`. */
const templates = new Map<number, FactionTemplateRow>();
let loading: Promise<void> | null = null;

/**
 * Load `FactionTemplate.dbc` once.
 *
 * Idempotent and shared: every unit that streams in asks for a reaction, and a per-unit fetch of a
 * ~2600-row table would be one request per wolf. The promise is the lock.
 */
export function primeFactionTemplates(): Promise<void> {
  if (loading === null) {
    loading = Promise.resolve(DBC.load('FactionTemplate'))
      .then((table: { records?: FactionTemplateRow[] }) => {
        for (const record of table?.records ?? []) {
          if (record && typeof record.id === 'number') {
            templates.set(record.id, record);
          }
        }
      })
      .catch(() => {
        // `DBC.load` logs and answers an empty table itself. An empty map means every reaction stays
        // unresolved, which `Unit#reaction` spells as null rather than as a wrong neutral.
      });
  }
  return loading;
}

/** True once the table is in memory. Callers use it to decide whether a reaction can be answered. */
export function factionTemplatesReady(): boolean {
  return templates.size > 0;
}

const ENEMY_SLOTS = 4;

function related(row: FactionTemplateRow, from: number, to: number, faction: number): boolean {
  const ids = row.relatedFactionIDs ?? [];
  for (let i = from; i < to; ++i) {
    if (ids[i] === faction) {
      return true;
    }
  }
  return false;
}

/**
 * `theirs` toward `mine`, on the 1..8 scale, or null while the table has not loaded.
 *
 * ARGUMENT ORDER IS THE UNIT'S TEMPLATE FIRST because the answer is the unit's feeling toward us,
 * which is what `UnitReaction("player", unit)` reports and what the frame colours by. The relation is
 * very nearly symmetric in practice but the masks are not required to be, and asking it the wrong way
 * round is the classic way to paint an enemy green.
 */
/**
 * `theirs` toward `mine` for two UNITS, memoised on the unit.
 *
 * THE ONE ENTRY POINT, because there are three callers that must agree: the snapshot the unit frames
 * read, the right-click attack gate, and any hover/nameplate work later. It was briefly resolved
 * inside `snapshotOf` alone, which meant a unit that had never been the target had `reaction === null`
 * for ever -- so "is this hostile?" could only be answered about a unit already selected, which is
 * exactly backwards for a gate that decides whether to select it.
 *
 * Null until `FactionTemplate.dbc` lands or if either template is absent; the memo is only written on
 * a real answer, so the next call retries.
 */
export function reactionFor(
  theirs: { fields: { factionTemplate?: number }; reaction: number | null },
  mine: { fields: { factionTemplate?: number } } | null,
): number | null {
  if (theirs.reaction !== null) {
    return theirs.reaction;
  }
  const their = theirs.fields.factionTemplate;
  const my = mine?.fields.factionTemplate;
  if (their === undefined || my === undefined || !factionTemplatesReady()) {
    return null;
  }
  theirs.reaction = reactionOf(their, my);
  return theirs.reaction;
}

export function reactionOf(theirTemplate: number, myTemplate: number): number | null {
  const theirs = templates.get(theirTemplate);
  const mine = templates.get(myTemplate);
  if (!theirs || !mine) {
    return null;
  }
  if (theirs === mine) {
    return REACTION_FRIENDLY;
  }

  if (theirs.factionID && mine.factionID) {
    if (related(theirs, 0, ENEMY_SLOTS, mine.factionID)) {
      return REACTION_HOSTILE;
    }
    if (related(theirs, ENEMY_SLOTS, ENEMY_SLOTS * 2, mine.factionID)) {
      return REACTION_FRIENDLY;
    }
  }

  if ((theirs.hostileMask & mine.groupMask) !== 0) {
    return REACTION_HOSTILE;
  }
  if (
    (theirs.friendlyMask & mine.groupMask) !== 0 ||
    (theirs.groupMask & mine.friendlyMask) !== 0
  ) {
    return REACTION_FRIENDLY;
  }
  return REACTION_NEUTRAL;
}
