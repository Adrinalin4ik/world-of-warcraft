import * as r from 'restructure';

import Entity from '../entity';

/**
 * `SpellVisual.dbc` -- the five animation/effect STAGES a spell drives, keyed from
 * `Spell.dbc.visualIDs[0]`.
 *
 * Only the leading columns are declared. That is safe rather than sloppy: `dbc/index.js#stridedRecord`
 * re-seeks to the next record boundary using `recordSize` from the file header, so a definition
 * narrower than the file cannot shift the following records. Declaring 28 further columns would mean
 * inventing 28 names, which the project rules treat as a defect -- so the ones with evidence are named
 * and the rest are simply not read.
 *
 * The served 3.3.5a file measures `recordCount = 9406`, `fieldCount = 32`, `recordSize = 128`
 * (32 * 4, so every column is 4 bytes and a field index is its offset / 4).
 *
 * Field roles are from `samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs:10` -- "Field 0
 * = id; field 1 = precastKit, field 2 = castKit, field 3 = impactKit, field 4 = ..." -- and were
 * re-verified here against the served file rather than taken on trust, because benilla is 1.12.1 and
 * records `SPELL_VISUAL_FIELDS = 16` where this build has 32. The indices survive the version change:
 * benilla's own byte-verified example (`spell_visual/mod.rs:78`, "Fireball, spell 133 -> visual 67:
 * precast 30 / cast 38") reproduces exactly on the 3.3.5a file, and spells 585 Smite (visual 128,
 * castKit 119), 2098 Eviscerate (671 / 733) and 78 Heroic Strike (39 / 324) all resolve to real kits.
 */
export default Entity({
  id: r.uint32le,
  precastKitID: r.uint32le,
  castKitID: r.uint32le,
  impactKitID: r.uint32le
});
