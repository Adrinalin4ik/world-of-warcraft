import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';
import { goIsActivatable } from '../../network/game/object/update-object/game-object-fields';
import { drawnWorldBox } from './pick';
import type Unit from '../classes/unit';

/**
 * THE SPARKLE ON A QUEST OBJECT -- the owner's "не забудь про анимацию над объектами целями... там
 * партиклы должны быть".
 *
 * Step 7 of the arc `pipeline/dbc/game-object-display-data.ts` opens, and the last visible one.
 *
 * ## THE TRIGGER IS BYTE-VERIFIED; THE ART IS CITED BUT NOT FOR THIS CASE
 *
 * Two halves with different standing, and they are kept apart rather than blended:
 *
 * **The trigger is the reference's, verbatim.** `GO_DYNFLAG_LO_ACTIVATE` (`0x1` in
 * `GAMEOBJECT_DYN_FLAGS`) is "the per-player 'usable for me now' bit the server sets from
 * `GameObject::ActivateToQuest` (sparkle)" -- `cursor_mode.rs:296-297`, its own words including the
 * parenthetical. So the flag that decides the glow is the same one that decides clickability, which is
 * why `cursor-mode.ts` and this file read one bit: an object that sparkles can be used and an object
 * that can be used sparkles. There is nothing to keep in step.
 *
 * **The art is cited for the CORPSE, and reused here as our inference.** The reference byte-verifies
 * `Particles\LootFX.mdl` as the client's `SpellVisualEffectName` row 5875, "HARDCODED Loot Art" -- "a
 * golden flare + three star-twinkle emitters; cadence/size/color/blend all authored in the asset, the
 * client sets none of them" (`creature_anim/spell_visual.rs:1232-1242`). That is verified for a
 * lootable corpse. **The reference draws no GameObjects at all, so it says nothing about this case**,
 * and no file this client ships states which art a quest object wears. Reusing the same hardcoded loot
 * art is the inference, and it is a narrow one: it is the client's own asset, served here (probed: 200
 * for both `particles/lootfx.m2` and its `.skin`), it is the same "you may loot this" statement, and
 * every visual parameter is authored in the file so nothing is invented on our side. If it turns out to
 * be the wrong row, the fix is one path in `MODEL` and this paragraph.
 *
 * ## PARENTED TO THE SCENE, NOT TO A BONE
 *
 * `quest-markers.ts` hangs its `!` off attachment 18 of a creature's skeleton, and that is right for a
 * marker over a head. A crate has no skeleton and no attachment table worth the name, so the effect
 * goes into the scene at a computed world point -- see `sparkleAt`, which records the three attempts
 * that took and why the attachment the reference cites is a CORPSE's slot rather than an object's.
 *
 * Both of `level-up-effect.ts`' traps apply and are honoured: `M2` sets `matrixAutoUpdate = false` on
 * itself and the scene has `matrixWorldAutoUpdate = false`, so an effect added without `updateMatrix()`
 * and `updateMatrixWorld(true)` draws at the world ORIGIN.
 *
 * **And the particle manager is not optional here.** `level-up-effect.ts` registers its model with
 * `map.particleManager` and that registration is what makes emitters emit. A sparkle added without it
 * would be a correctly placed, correctly scaled, completely invisible model -- the exact "a draw call
 * is not a pixel" failure `CLAUDE.md` records. So a null manager means no sparkle rather than a silent
 * nothing, and `stats.noManager` counts it.
 *
 * ## COST
 *
 * **Zero UI draw-fingerprint**, by construction: these are models in the world scene and
 * `drawListSignature` mixes interface draw items only -- the same reason `quest-markers.ts` and
 * `selection-ring.ts` cost nothing there.
 *
 * Per frame the work is a walk over `entities` testing one field, plus a `Map` lookup per object that
 * has one. That is the same walk `quest-markers.ts#update` already does over the same collection, and
 * the reconcile allocates nothing on the steady path: a sparkle is created when the bit rises and
 * removed when it falls, both edges, never per frame.
 */
export class GameObjectSparkle {
  /** The client's own hardcoded loot art. Lowercased for the case-sensitive host. See the header. */
  private static readonly MODEL = 'particles\\lootfx.m2';

  /** guid -> its live sparkle. */
  private live = new Map<string, { model: THREE.Object3D; manager: ParticleManager | null }>();

  /** Guids whose load is in flight, so a slow fetch cannot start a second one. */
  private loading = new Set<string>();

  /** `window.worldGameObjectSparkle()` reads this. */
  public stats = { live: 0, created: 0, removed: 0, noManager: 0, noModel: 0 };

  constructor(private scene: THREE.Scene) {}

  /**
   * Reconcile the live sparkles against the world.
   *
   * `manager` is `map.particleManager` and may be null before a map exists -- see the header on why
   * that means no sparkle rather than an invisible one.
   */
  update(entities: Map<string, Unit>, manager: ParticleManager | null): void {
    // DROP FIRST, so an object that was used this frame stops glowing before anything else runs. The
    // falling edge is `ActivateToQuest` clearing the bit, which arrives as a values-only block.
    for (const [guid, entry] of Array.from(this.live)) {
      const unit = entities.get(guid);
      if (unit === undefined || unit.gameObject === null || !goIsActivatable(unit.gameObject.dynamic)) {
        entry.manager?.unregister(entry.model);
        this.scene.remove(entry.model);
        M2Blueprint.unload(entry.model as never);
        this.live.delete(guid);
        this.stats.removed += 1;
      }
    }

    for (const [guid, unit] of entities) {
      if (unit.gameObject === null || !goIsActivatable(unit.gameObject.dynamic)) {
        continue;
      }
      if (this.live.has(guid) || this.loading.has(guid)) {
        continue;
      }
      if (manager === null) {
        // Counted rather than skipped in silence: an unregistered effect is invisible, so this would
        // otherwise read as "the sparkle does not work" with nothing to point at.
        this.stats.noManager += 1;
        continue;
      }
      this.spawn(guid, unit, manager);
    }
    this.stats.live = this.live.size;
  }

  private spawn(guid: string, unit: Unit, manager: ParticleManager): void {
    this.loading.add(guid);
    // WHERE it goes is `sparkleAt` -- three attempts are recorded there, including why the
    // attachment the reference cites does not cover this case.
    const at = sparkleAt(unit);
    void M2Blueprint.load(GameObjectSparkle.MODEL)
      .then((model: THREE.Object3D & { updateMatrix?: () => void }) => {
        this.loading.delete(guid);
        // The object may have been used, or gone out of range, while the fetch was out.
        const still = entitiesStillWant(unit);
        if (!still || this.live.has(guid)) {
          M2Blueprint.unload(model as never);
          return;
        }
        model.position.copy(at);
        // BOTH CALLS, and neither is optional -- see the header. Without them the sparkle draws at the
        // world origin, which is the trap `level-up-effect.ts` and `unit.ts#applyRenderScale` record.
        if (typeof model.updateMatrix === 'function') {
          model.updateMatrix();
        }
        this.scene.add(model);
        model.updateMatrixWorld(true);
        // THE REGISTRATION IS WHAT MAKES IT EMIT. See the header.
        manager.register(model);
        this.live.set(guid, { model, manager });
        this.stats.created += 1;
      })
      .catch(() => {
        this.loading.delete(guid);
        // `M2Blueprint.load` logs its own failure. A missing effect model is a missing glow, not a
        // broken object: the cursor and the click read the same flag and are unaffected.
        this.stats.noModel += 1;
      });
  }

  /** Drop every sparkle -- a world teardown. */
  dispose(): void {
    for (const [, entry] of this.live) {
      entry.manager?.unregister(entry.model);
      this.scene.remove(entry.model);
      M2Blueprint.unload(entry.model as never);
    }
    this.live.clear();
    this.loading.clear();
  }
}

/** What `map.particleManager` is, to the extent this file uses it. */
interface ParticleManager {
  register: (instance: unknown) => number;
  unregister: (instance: unknown) => void;
}

/**
 * WHERE THE SPARKLE GOES -- the centre of the geometry that is actually DRAWN.
 *
 * Third attempt at this, and the first two failed in instructive ways. `view.position` alone put it at
 * the bucket's feet, because a doodad's origin is where it meets the ground. Lifting by
 * `M2#vertexRadius * scale` -- the quantity `pick.ts` sizes its pick sphere with -- did not fix it
 * either, and the owner said so plainly.
 *
 * **And the attachment I promised is the wrong answer for an object.** The reference hangs the loot art
 * from attach `0x13` (`creature_anim/spell_visual.rs:37`), but that is a slot on a CREATURE's skeleton
 * and the case it byte-verifies is a lootable CORPSE. A crate has no skeleton and no attachment table
 * worth the name, so `attachTo` would answer false and render nothing -- which is how
 * `quest-markers.ts` already documents that path behaving ("no slot => created but never parented --
 * invisible"). Reporting that rather than shipping it: naming a citation is not the same as the
 * citation covering your case.
 *
 * So this uses the DRAWN geometry instead of any authored number. `drawnWorldBox` is already exported
 * from `pick.ts`, where it is the narrow phase's own world box -- the union of every visible submesh's
 * bounds, after `updateWorldMatrix`. Its centre is the middle of the thing the player can see,
 * whatever the model's origin convention, its scale, or whether its header radius is meaningful.
 * A model with nothing drawn yet answers null, and then the object's own position stands in.
 *
 * Cost: one bounding-box union per sparkle CREATED, not per frame -- this runs once, on the rising edge.
 */
function sparkleAt(unit: Unit): THREE.Vector3 {
  const box = drawnWorldBox(unit);
  if (box === null) {
    return unit.view.position.clone();
  }
  return new THREE.Vector3(
    (box[0] + box[3]) / 2,
    (box[1] + box[4]) / 2,
    (box[2] + box[5]) / 2,
  );
}

/** Does this object still want a sparkle? Split out so the async path reads as one condition. */
function entitiesStillWant(unit: Unit): boolean {
  return unit.gameObject !== null && goIsActivatable(unit.gameObject.dynamic);
}

export default GameObjectSparkle;
