/**
 * The texture supply answers when it has settled.
 *
 * WHY THIS AND NOT MORE. The defect was that a runtime texture supply went out through a SETTER, so
 * the loads it started were unreachable: an item was reported attached before its skin existed and a
 * failure on that skin reached nobody (bluebird: "a promise was created in a handler at ... but was
 * not returned from it", through `set objectTexture`). The fix is that every supply is a method that
 * answers a promise, and the one thing worth pinning here is exactly that -- the promise does not
 * resolve until every batch's material has finished. Everything else about texture loading is the
 * loader's, and `__tests__/texture-loader-references.test.ts` already owns that.
 *
 * Two tests, both happy path, per the standing constraint on this project.
 *
 * @jest-environment node
 */
import Submesh from '../submesh';
import { collectTextureLoads } from '../material';

/** A material stub with a supply whose promise this test controls. */
function batch() {
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const material = {
    supplied: null as string | null,
    updateObjectTexture(path: string | null) {
      material.supplied = path;
      return done.then(() => []);
    },
  };
  return { material, settle, mesh: { material } };
}

describe('the M2 texture supply', () => {
  it('resolves only once every batch material has finished, with no failures', async () => {
    const first = batch();
    const second = batch();
    // `setObjectTexture` walks `this.children`; the real Submesh is a THREE.Group whose children are
    // its batch meshes. Calling it against that shape keeps the test to the method under test rather
    // than to geometry construction.
    const submesh: any = { children: [first.mesh, second.mesh] };

    const supply = Submesh.prototype.setObjectTexture.call(submesh, 'Item\\Sword.blp');

    // Both batches were supplied synchronously -- the slots are claimed at once and only the fetch
    // is asynchronous.
    expect(first.material.supplied).toBe('Item\\Sword.blp');
    expect(second.material.supplied).toBe('Item\\Sword.blp');

    let settled = false;
    supply.then(() => {
      settled = true;
    });

    first.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    second.settle();
    expect(await supply).toEqual([]);
  });

  it('flattens the per-batch results into one list', async () => {
    expect(await collectTextureLoads([])).toEqual([]);
    expect(
      await collectTextureLoads([
        Promise.resolve([]),
        Promise.resolve([{ path: 'A.blp', error: 'boom' }]),
      ]),
    ).toEqual([{ path: 'A.blp', error: 'boom' }]);
  });
});
