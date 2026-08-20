/**
 * THE UPPER-BODY SPLIT -- which bones a masked one-shot overlay drives, and which keep the gait.
 *
 * This is the boundary behind "the legs run, the upper body fights". It is NOT a hardcoded bone
 * index and not a guess at anatomy: it is the model's own **split key-bone**, the client's
 * `CGUnit+0xd5c`, selected by the capability probe `0x60ce70` -- `keyBoneLookup[4]` (SpineLow)
 * preferred, `[6]` (Head) as the fallback, and the `-1` sentinel meaning THIS MODEL HAS NO SPLIT, in
 * which case the one-shot route falls back to full body. That is the reference's
 * `benilla-assets/src/model.rs:379-390` (`upper_subtree_root`), whose mask groups are built at
 * `benilla-assets/src/m2.rs:493-503`: "group 2 collects every joint *outside* the SpineLow subtree
 * (the legs + pelvis), so a clip masked with it animates only the upper body".
 *
 * A bone carries KeyBoneID `k` iff `keyBoneLookup[k]` points at it, which is the same thing as that
 * bone's own `keyBoneID` field being `k` -- so the lookup table is not needed and this reads
 * `boneDefs[i].keyBoneID`, which `wow-data-parser/m2/index.js:27` already parses.
 *
 * ## MEASURED on 3.3.5a data, and it CORRECTS the reference's own numbers
 *
 * `character/human/male/humanmale.m2` off the live host (`MD20` version **264**, 1,585,376 bytes,
 * 138 bones, `keyBoneLookup` 27 entries = `17,18,10,11,2,3,16,29,45,...`):
 *
 * - `keyBoneLookup[4]` is bone **2** (pivot z 1.21), whose parent is bone 1 (KeyBoneID 26, Root).
 *   The reference's doc says "On HumanMale `keyBoneLookup[4]` is bone 20" -- that is its 1.12.1 rig
 *   and it does NOT hold here. Mechanism from the reference, numbers from the game's own data.
 * - The split lands exactly where the split is supposed to land. Bone 2's subtree is **94 of 138**
 *   bones, z range 0.43..2.03 -- chest, shoulders (KeyBoneID 2/3 at bone 10/11), arms, every finger
 *   key-bone (8..17 at bones 40..49), head (KeyBoneID 6 at bone 16) and jaw.
 * - The **legs are provably outside it**. Bone 2's sibling under Root is bone **3** (KeyBoneID 5,
 *   Waist, z 1.16), and ITS subtree is the other 22 bones: thighs at y ±0.13 / z 1.08, knees z 0.58,
 *   feet z 0.02..0.10. So a clip masked to the SpineLow subtree cannot move a leg.
 *
 * The mask is built ONCE PER MODEL (cached on `ModelAnim`), never per instance and never per frame:
 * the per-frame cost of the split is one byte read per bone inside a pass that was already there.
 */

/** `KeyBoneID` 4 -- SpineLow. The preferred split root (`benilla-assets/src/model.rs:387`). */
export const KEY_BONE_SPINE_LOW = 4;

/** `KeyBoneID` 6 -- Head. The fallback split root when a rig carries no SpineLow. */
export const KEY_BONE_HEAD = 6;

/**
 * The model's upper-body split root, or -1 for the client's "no split" sentinel.
 *
 * `boneDefs` is the raw parsed bone list in file order -- the same indexing `InstanceAnim`'s palette
 * and `localTRS` use, so an index from here addresses the solver's bones directly.
 */
export function upperSubtreeRoot(boneDefs: readonly any[]): number {
  let head = -1;
  for (let i = 0; i < boneDefs.length; ++i) {
    const key = boneDefs[i]?.keyBoneID;
    if (key === KEY_BONE_SPINE_LOW) {
      return i;
    }
    if (key === KEY_BONE_HEAD && head < 0) {
      head = i;
    }
  }
  return head;
}

/**
 * One byte per bone: 1 iff the bone is the split root or one of its descendants.
 *
 * `null` when the model has no split key-bone -- the `-1` sentinel -- and the caller must then route
 * the one-shot FULL BODY rather than mask it to nothing (the reference's "the route falls back to
 * full-body on the base node", `benilla-assets/src/model/anims.rs:72-73`). A mask of all zeroes would
 * be the silent version of that: an overlay armed and invisible.
 *
 * Built by a parent-chain walk per bone (`in_subtree`, `benilla-assets/src/model.rs:411`) rather than
 * a child-list descent, because the parsed bone list gives parents and nothing else. Bones are stored
 * parent-before-child in every M2 this project has read, so a single forward pass would in practice
 * do -- but "in practice" is not a guarantee the file format makes, and this runs once per model.
 * The walk is bounded by the bone count so malformed data degrades to a wrong mask, not a hang.
 */
export function upperBodyMask(boneDefs: readonly any[]): Uint8Array | null {
  const root = upperSubtreeRoot(boneDefs);
  if (root < 0) {
    return null;
  }
  const count = boneDefs.length;
  const mask = new Uint8Array(count);
  for (let i = 0; i < count; ++i) {
    let cur = i;
    for (let steps = 0; steps <= count; ++steps) {
      if (cur === root) {
        mask[i] = 1;
        break;
      }
      if (cur < 0 || cur >= count) {
        break;
      }
      cur = boneDefs[cur].parentID;
    }
  }
  return mask;
}
