import {
  emptyGameObjectState, goIsActivatable, goState, GO_STATE, mergeGameObjectFields,
} from '../game-object-fields';
import { GameObjectField, ObjectField, ObjectType, getUpdateFieldName } from '../../enums';

/**
 * THE MERGE CONTRACT, and the return value in particular.
 *
 * What this asserts is the CONTRACT -- a word that arrives is written, a word that does not is left
 * alone, and `changed` says which happened. It deliberately does NOT claim to verify the offsets: it
 * builds its input through the same `getUpdateFieldName` the decoder reads with, so on that question it
 * is self-consistent and nothing more. The offsets are checked where they can be, by the arithmetic in
 * the file's header -- `parentrotation` at 0x0004 spanning four words meets `dynamic` at 0x0008 with no
 * hole and no overlap -- and by the block being 3.3.5a's own `UpdateFields.h` layout.
 *
 * The return is the half worth a test. `CLAUDE.md` records a discarded merge return hiding a defect
 * twice, and here it would mean a crate that was used keeps its sparkle and stays clickable for the
 * rest of the session with the map correct throughout.
 */
const nameOf = (index: number) => getUpdateFieldName(index, ObjectType.GameObject);

test('a values block writes only the words it carries, and says whether anything moved', () => {
  const state = emptyGameObjectState();

  // First sight: entry, model, and the activate bit that makes it glow and clickable.
  expect(mergeGameObjectFields(state, {
    [nameOf(ObjectField.object_field_entry)]: 1732,
    [nameOf(GameObjectField.gameobject_displayid)]: 259,
    [nameOf(GameObjectField.gameobject_dynamic)]: 1,
    [nameOf(GameObjectField.gameobject_bytes_1)]: GO_STATE.READY,
  }, ObjectType.GameObject)).toBe(true);
  expect(state.entry).toBe(1732);
  expect(state.displayId).toBe(259);
  expect(goIsActivatable(state.dynamic)).toBe(true);
  expect(goState(state.bytes1)).toBe(GO_STATE.READY);

  // The same block again: nothing moved, so nothing is announced and nothing repaints.
  expect(mergeGameObjectFields(state, {
    [nameOf(GameObjectField.gameobject_displayid)]: 259,
  }, ObjectType.GameObject)).toBe(false);

  // USED. The activate bit falls and the state flips -- and `GO_STATE.ACTIVE` is 0, which is why the
  // sense is named rather than inlined: a `!== 0` test would read a used object as ready.
  expect(mergeGameObjectFields(state, {
    [nameOf(GameObjectField.gameobject_dynamic)]: 0,
    [nameOf(GameObjectField.gameobject_bytes_1)]: GO_STATE.ACTIVE,
  }, ObjectType.GameObject)).toBe(true);
  expect(goIsActivatable(state.dynamic)).toBe(false);
  // The display id was not in that block, so it is UNCHANGED rather than zeroed.
  expect(state.displayId).toBe(259);

  // A unit's block must not be read as an object's -- the guard that keeps `fields` and `gameObject`
  // from being written from each other's packets.
  expect(mergeGameObjectFields(state, {
    [nameOf(GameObjectField.gameobject_displayid)]: 999,
  }, ObjectType.Unit)).toBe(false);
  expect(state.displayId).toBe(259);
});
