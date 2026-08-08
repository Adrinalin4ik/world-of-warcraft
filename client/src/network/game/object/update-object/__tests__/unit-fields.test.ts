/**
 * Two tests, happy path, per the project's rule -- one for each of the two things that were wrong
 * and that nothing else would catch.
 */
import Unit from '../../../../../game/classes/unit';
import { ObjectType, UnitField, getUpdateFieldName } from '../../enums';
import { applyUnitFields, isDead } from '../unit-fields';

describe('unit fields', () => {
  /**
   * The lookup that made the whole feature impossible: it ignored its type argument and answered
   * `ItemField` names for five of the seven fields a unit frame needs. These five indices are the
   * ones that actually collided; if the scoping regresses, they are what breaks first.
   */
  it('resolves unit field names against the unit chain, not the item one', () => {
    expect(getUpdateFieldName(UnitField.unit_field_health, ObjectType.Unit)).toBe('unit_field_health');
    expect(getUpdateFieldName(UnitField.unit_field_level, ObjectType.Unit)).toBe('unit_field_level');
    expect(getUpdateFieldName(UnitField.unit_field_factiontemplate, ObjectType.Unit))
      .toBe('unit_field_factiontemplate');
    expect(getUpdateFieldName(UnitField.unit_field_power1, ObjectType.Unit)).toBe('unit_field_power1');
    expect(getUpdateFieldName(UnitField.unit_field_flags, ObjectType.Unit)).toBe('unit_field_flags');
    // A player resolves the unit fields too -- `Player : Unit` in the server's own descriptors.
    expect(getUpdateFieldName(UnitField.unit_field_health, ObjectType.Player)).toBe('unit_field_health');
  });

  /**
   * One create block as the wire actually delivers it, taken from the live capture in this round's
   * report: `Gesf` at level 1, 60/60 health, power type 1 (RAGE) with max 1000. Then the damage tick
   * that kills him, which is the only way death arrives.
   */
  it('reads a create block and then a values-only health change', () => {
    const unit = new Unit('0x59a6');
    const create = {
      unit_field_level: 1,
      unit_field_health: 60,
      unit_field_maxhealth: 60,
      unit_field_bytes_0: 1 << 24,
      unit_field_maxpower1: 0,
      unit_field_power2: 1000,
      unit_field_maxpower2: 1000,
      unit_field_factiontemplate: 1,
    };
    expect(applyUnitFields(unit, create, ObjectType.Player, true)).toBe(true);
    expect(unit.fields.level).toBe(1);
    expect(unit.fields.health).toBe(60);
    expect(unit.fields.maxHealth).toBe(60);
    // Power type 1 is RAGE, and it selects slot 2 (`unit_field_power1` is index 0's mana).
    expect(unit.fields.powerType).toBe(1);
    expect(unit.fields.maxPower).toBe(1000);
    expect(isDead(unit)).toBe(false);

    // A values-only update carries only what moved. Everything else must survive it.
    expect(applyUnitFields(unit, { unit_field_health: 0 }, ObjectType.Player, false)).toBe(true);
    expect(unit.fields.health).toBe(0);
    expect(unit.fields.maxHealth).toBe(60);
    expect(unit.fields.level).toBe(1);
    expect(isDead(unit)).toBe(true);

    // No change means no announcement -- the gate that keeps the UI's offscreen target valid.
    expect(applyUnitFields(unit, { unit_field_health: 0 }, ObjectType.Player, false)).toBe(false);
  });
});
