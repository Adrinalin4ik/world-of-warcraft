/** @jest-environment node */
import { DecodeStream } from 'restructure';

import Spell from '../spell';

/**
 * `Spell.dbc`'s 3.3.5a column layout, which the entity definition got WRONG.
 *
 * It carried `EffectBaseDice` and `EffectDicePerLevel` (3 columns each), which existed through 2.4.3 and
 * were removed in 3.x, and it had one column too few at the tail. Net effect: 6 spurious columns before
 * `iconID`, so `iconID` read a byte offset inside the `Name` locale block and every icon lookup failed --
 * which is why the action bar had no icons.
 *
 * The two indices below were established by measurement against the served
 * `dbfilesclient/spell.dbc` (`recordCount = 49839`, `fieldCount = 234`, `recordSize = 936` -- exactly
 * `234 * 4`, so a field index is its byte offset / 4): scanning spell 133's record for the column that
 * resolves to the string "Fireball" gives **136**, and for the column holding a `SpellIcon.dbc` id that
 * names `Spell_Fire_FlameBolt` gives **133**.
 *
 * This test exists because a shift here is INVISIBLE -- every record still decodes, the numbers still
 * look like numbers, and only an icon that never appears says anything is wrong.
 */

const FIELD_COUNT = 234;
const RECORD_SIZE = FIELD_COUNT * 4;

/** Field indices as measured on the served file. */
const ICON_COLUMN = 133;
const NAME_COLUMN = 136;

const ICON_ID = 185; // SpellIcon.dbc 185 = Interface\Icons\Spell_Fire_FlameBolt
const SPELL_ID = 133; // Fireball

/** A one-record `Spell.dbc` whose id, icon and name sit at the measured columns. */
function buildSpellDbc() {
  const name = 'Fireball';
  // String block: a leading NUL (offset 0 means "no string" by convention), then the name.
  const nameOffset = 1;
  const stringBlock = new Uint8Array(1 + name.length + 1);
  for (let i = 0; i < name.length; i += 1) {
    stringBlock[nameOffset + i] = name.charCodeAt(i);
  }

  const buffer = new ArrayBuffer(20 + RECORD_SIZE + stringBlock.length);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x57; // 'W'
  bytes[1] = 0x44; // 'D'
  bytes[2] = 0x42; // 'B'
  bytes[3] = 0x43; // 'C'
  view.setUint32(4, 1, true); // recordCount
  view.setUint32(8, FIELD_COUNT, true);
  view.setUint32(12, RECORD_SIZE, true);
  view.setUint32(16, stringBlock.length, true);

  const column = (index, value) => view.setUint32(20 + index * 4, value, true);
  column(0, SPELL_ID);
  column(ICON_COLUMN, ICON_ID);
  column(NAME_COLUMN, nameOffset);

  bytes.set(stringBlock, 20 + RECORD_SIZE);
  return buffer;
}

test('Spell.dbc decodes iconID at column 133 and name at column 136', () => {
  // `Spell.dbc`, not `Spell.default.dbc`: the pipeline loader reaches these through
  // `import * as DBC from '.../entities'`, so it holds NAMESPACE objects and needs the `.default` hop.
  // A direct default import is already the entity.
  const decoded = Spell.dbc.decode(new DecodeStream(Buffer.from(buildSpellDbc())));

  expect(decoded.fieldCount).toBe(FIELD_COUNT);
  expect(decoded.recordSize).toBe(RECORD_SIZE);

  const record = decoded.records[0];
  expect(record.id).toBe(SPELL_ID);
  // The whole point: both land on the measured columns, so the definition's total width up to each one
  // is right. Before the fix `iconID` read column 139 and `name` column 142.
  expect(record.iconID).toBe(ICON_ID);
  expect(record.name).toBe('Fireball');
});
