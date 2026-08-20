/**
 * The three-state verdict, which is the whole of what closing a window on range gets right or wrong.
 *
 * ONE TEST, per `CLAUDE.md`. It is the one worth having because the interesting case is not "far" --
 * that is a comparison -- but the difference between `gone` and `keep` for a source we hold no entity
 * for. A loot source can be an ITEM guid (a lockbox) or a GameObject (a chest), neither of which this
 * client puts in `world.entities`, so treating "not found" as `gone` would slam such a window shut the
 * instant it opened. `seen` is what separates "it despawned" from "we never had it".
 */
import { verdictFor } from '../interaction-watch';

it('separates far, gone and never-seen', () => {
  // In range -> keep, whether or not it was ever resolved.
  expect(verdictFor(9, 30.864, true)).toBe('keep');
  // Out of range, still there -> far. Boundary is inclusive: exactly at the gate is still in.
  expect(verdictFor(30.864, 30.864, true)).toBe('keep');
  expect(verdictFor(30.9, 30.864, true)).toBe('far');
  // No entity, but we HAD one -> it despawned or left our update range.
  expect(verdictFor(null, 30.864, true)).toBe('gone');
  // No entity and we never had one -> an item or GameObject source. LEAVE IT ALONE.
  expect(verdictFor(null, 30.864, false)).toBe('keep');
});
