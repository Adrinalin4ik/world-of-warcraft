import * as r from 'restructure';

import SpellVisual from '../spell-visual';
import SpellVisualKit from '../spell-visual-kit';

/**
 * These fixtures are **real records**, copied word for word out of the served 3.3.5a
 * `SpellVisual.dbc` and `SpellVisualKit.dbc` (`https://data-direct.spelunkerdb.com/12340`, decoded
 * against the file header's own `recordSize`). They are not synthesised from the declarations, so a
 * column named at the wrong index fails here rather than agreeing with itself -- which is the whole
 * point, since both layouts shifted between 1.12 (the reference's build) and this one.
 *
 * Each asserted value is one of the anchors the two entity docstrings cite: Fireball's precast 30 /
 * cast 38 / impact 286 and its missile model 365, and kit 38's anim 53 / sound 1484 -- benilla's own
 * byte-verified numbers (`samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs:78-80`) --
 * plus kit 285's world-plant model 284 `Frost_Nova_state.mdx`, which is what pins the +2 shift on the
 * kit table's second half.
 */
describe('SpellVisual / SpellVisualKit column layout', () => {
  const decode = (entity, words) => {
    const buffer = Buffer.alloc(words.length * 4);
    words.forEach((word, i) => buffer.writeInt32LE(word, i * 4));
    return entity.decode(new r.DecodeStream(buffer));
  };

  it('reads Fireball visual 67 out of the real SpellVisual record', () => {
    // The served record for id 67, all 32 words.
    const record = decode(SpellVisual, [
      67, 30, 38, 286, 0, 0, 0, 1, 365, 0, 1, 3011, 0, 1, 0, 0,
      -1, 100, 300, 750, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);

    expect(record.id).toBe(67);

    // The three stages benilla verified, at the indices it puts them (1/2/3 did not move).
    expect(record.precastKitID).toBe(30);
    expect(record.castKitID).toBe(38);
    expect(record.impactKitID).toBe(286);

    // Fireball is not channelled and has no state kit, so the shifted stage columns read 0 -- what
    // matters is that `channelKitID` lands on index 6 and not on the near-empty inserted column 5.
    expect(record.stateKitID).toBe(0);
    expect(record.channelKitID).toBe(0);

    // The missile block, one index later than benilla's throughout.
    expect(record.hasMissile).toBe(1);
    expect(record.missileModelID).toBe(365); // -> Spells\Fireball_Missile_Low.mdx
    expect(record.missileDestinationAttachment).toBe(1);
    expect(record.missileSoundID).toBe(3011);
    expect(record.flags).toBe(1);
    expect(record.missileAttachment).toBe(-1);
    expect(record.missileFollowGround).toEqual([100, 300, 750, 6]);
  });

  /**
   * THE STATE STAGE, on a row that actually uses it -- Mana Shield.
   *
   * Fireball's record above pins `stateKitID` only by reading 0 there, which a wrongly indexed column
   * would also do on a record whose neighbours are all zero. This is the positive case, and it is the
   * spell the owner reported: `Spell.dbc` 1463 Mana Shield -> visual **968** -> state kit **990** ->
   * base slot effect **718** -> `Spells\ManaShield_State_Base.mdx`. Both records are the served
   * bytes, all 32 and all 38 words.
   *
   * Field 4 is one of the four indices 3.3.5a did NOT move, so it is also the one stage column where
   * the reference's own index transfers -- and asserting it here is what makes that a check rather
   * than an assumption.
   */
  it('reads the STATE kit at field 4 on the real Mana Shield visual and kit records', () => {
    const visual = decode(SpellVisual, [
      968, 266, 267, 0, 990, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
      -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);
    expect(visual.id).toBe(968);
    expect(visual.stateKitID).toBe(990);
    // The inserted 3.3.5a column (index 5) and the shifted channel column (index 6) both read 0 in
    // the record above, so the state kit cannot have come out of either of them. Only the channel
    // column is ASSERTABLE -- index 5 is declared `r.Reserved` precisely because seven rows support
    // no name for it, so it is absent from the decoded object by design and its zero is visible in
    // the literal rather than in an expectation.
    expect(visual.channelKitID).toBe(0);

    const kit = decode(SpellVisualKit, [
      990, -1, -1, 0, 0, 718, 0, 0, 0, 0, 0, 0, 0, 0, 0, 39,
      0, -1, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);
    expect(kit.id).toBe(990);
    // The BASE slot -- kit field 5, the unit's feet, which is where the state stage overwhelmingly
    // lives (902 of the 2237 effect slots on state kits).
    expect(kit.baseEffectID).toBe(718);
    expect(kit.headEffectID).toBe(0);
    expect(kit.chestEffectID).toBe(0);
    // The kit sound at field 15, and the four CharProc keys all empty -- Mana Shield's whole visual
    // is the one base model.
    expect(kit.soundID).toBe(39);
    expect(kit.charProcTypes).toEqual([-1, -1, -1, -1]);
    // The dual none-sentinel on the anim column: this kit carries the `-1` form.
    expect(kit.animID).toBe(0xffffffff);
  });

  it('reads missileModelID as SIGNED, so a -1 row means no missile and not ErrorCube', () => {
    // The same Fireball record with column 8 replaced by the raw 0xFFFFFFFF that 51 of the served
    // rows carry (90 rows are negative in total). Read as `uint32` this is 4294967295, which passes
    // the reference's `>= 1` missile gate, fails the SpellVisualEffectName lookup and comes out as the
    // literal `Spells\\ErrorCube.mdx` -- measured to turn a 2-visual error path into a 92-visual one.
    const record = decode(SpellVisual, [
      67, 30, 38, 286, 0, 0, 0, 1, -1, 0, 1, 3011, 0, 1, 0, 0,
      -1, 100, 300, 750, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);

    expect(record.missileModelID).toBe(-1);
    expect(record.missileModelID).toBeLessThan(1);
  });

  it('reads kits 38 and 285 out of the real SpellVisualKit records', () => {
    // Fireball's cast kit: anim 53 SpellCastDirected, sound 1484 "Fire Cast", the same effect id 288
    // in both hand slots.
    const cast = decode(SpellVisualKit, [
      38, -1, 53, 0, 0, 0, 288, 288, 0, 0, 0, 0, 0, 0, 0, 1484, 0, -1, -1, -1,
      -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);

    expect(cast.animID).toBe(53);
    expect(cast.soundID).toBe(1484); // benilla's field 13; index 15 here
    expect(cast.handEffectIDs).toEqual([288, 288]);

    // Frost Nova's state kit: the world-plant slot carries 284 Frost_Nova_state.mdx, and one TINT
    // CharProc (type 1) whose params are spread across the four parallel param blocks.
    const state = decode(SpellVisualKit, [
      285, -1, -1, 54, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 284, 1502, 0, 1, -1, -1,
      -1, 1254936062, 0, 0, 0, 0, 0, 0, 0, 1065353216, 0, 0, 0, 1056964608, 0, 0, 0, 0
    ]);

    expect(state.headEffectID).toBe(54);
    expect(state.worldEffectID).toBe(284); // benilla's field 12; index 14 here
    expect(state.soundID).toBe(1502);
    expect(state.charProcTypes).toEqual([1, -1, -1, -1]);

    // The transposition: slot 0's params are element 0 of each block, not four contiguous columns.
    // 6711039 is 0x6666FF, a packed RGB in the TINT proc's params[0].
    expect(state.charParamZero[0]).toBeCloseTo(6711039, 0);
    expect(state.charParamTwo[0]).toBeCloseTo(1.0, 5);
    expect(state.charParamThree[0]).toBeCloseTo(0.5, 5);
  });
});
