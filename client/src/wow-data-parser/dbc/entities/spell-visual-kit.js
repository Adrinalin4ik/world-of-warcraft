import * as r from 'restructure';

import Entity from '../entity';

/**
 * `SpellVisualKit.dbc` -- one stage's kit. The only column this client reads is `animID`.
 *
 * Narrow by design, for the reason given in `spell-visual.js`: `stridedRecord` realigns on the header's
 * `recordSize`, so unread trailing columns cannot corrupt anything, and naming columns without evidence
 * is worse than not reading them. The served 3.3.5a file measures `recordCount = 8663`,
 * `fieldCount = 38`, `recordSize = 152` (38 * 4).
 *
 * `startAnimID` (field 1) and `animID` (field 2) are from
 * `samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs` (field 2 is the one its
 * `VisualKit::anim_id` reads). benilla records `SPELL_VISUAL_KIT_FIELDS = 35` against this build's 38,
 * so again the count moved and the index did not: kit 38 resolves to `animID = 53`, which is
 * `AnimationData.dbc` id 53 `SpellCastDirected` -- benilla's own verified value for Fireball's cast kit
 * (`spell_visual/mod.rs:79`).
 *
 * **The none-sentinel is dual.** benilla found empirically (`spell_visual/mod.rs:66-75`) that "no
 * value" for the anim column is written as EITHER `0` OR `0xFFFFFFFF`, inconsistently, across the real
 * table -- 41 kits carry `0` and 875 carry `0xFFFFFFFF`. Both must fold to "absent" or a kit with the
 * `-1` form resolves to animation id 4294967295 and a kit with the `0` form resolves to id 0
 * (`Stand`), which would silently park a caster in an idle. `castAnimationFor` in
 * `game/classes/spell-anim.ts` is the single place that folding happens.
 */
export default Entity({
  id: r.uint32le,
  startAnimID: r.uint32le,
  animID: r.uint32le
});
