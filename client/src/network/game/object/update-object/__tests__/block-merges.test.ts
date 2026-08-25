import { ObjectType, PlayerField, UnitField, getUpdateFieldName } from '../../enums';
import { emptyCharacterStats, mergeCharacterStats } from '../character-stats';
import { emptySkills, mergePlayerSkills } from '../player-skills';

/**
 * THE FLAG, NOT THE CONTENTS.
 *
 * Both merges used to return their containers, and `readUnitFields` discarded the result. `changed` is
 * what `update-object/handler.ts:267,381` gates `world.emit('unit:fields', unit)` on, so a packet
 * carrying only stat words or only a skill slot fired no event at all and the character sheet kept its
 * previous answer -- the same dropped boolean that cost the quest log its rows.
 *
 * Two assertions each, and they are the two the gate needs: a real change says true, and a RE-SEND of
 * the same value says false. The second matters because an update mask is sparse but not minimal -- a
 * create block resends every stat a character has -- so "a word arrived" is not a change.
 */
const key = (index: number) => getUpdateFieldName(index, ObjectType.Player) as string;

test('a lone stat word reports a change, and re-sending it does not', () => {
  const stats = emptyCharacterStats();
  const agility = { [key(UnitField.unit_field_stat0 + 1)]: 37 };

  expect(mergeCharacterStats(stats, agility, ObjectType.Player)).toBe(true);
  expect(stats.stats[1]).toBe(37);
  expect(mergeCharacterStats(stats, agility, ObjectType.Player)).toBe(false);
});

test('a lone skill slot reports a change, and unlearning it reports one too', () => {
  const skills = emptySkills();
  const base = PlayerField.player_skill_info_1_1;
  const learned = {
    [key(base + 0)]: 129 | (0 << 16),
    [key(base + 1)]: 42 | (75 << 16),
  };

  expect(mergePlayerSkills(skills, learned, ObjectType.Player)).toBe(true);
  expect(skills.get(0)).toMatchObject({ id: 129, value: 42, max: 75 });
  expect(mergePlayerSkills(skills, learned, ObjectType.Player)).toBe(false);

  // A zero id is how the server says the skill is gone -- and that is a change the panel must see.
  expect(mergePlayerSkills(skills, { [key(base + 0)]: 0 }, ObjectType.Player)).toBe(true);
  expect(skills.size).toBe(0);
});
