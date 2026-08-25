/**
 * The MOUSEOVER / TARGET model brighten -- "Наведение на цель должно ее немного подсвечивать."
 *
 * ## What it is in the real client, and where every number here comes from
 *
 * It is not a shell, an outline or a second draw. A CM2 model instance carries a per-instance
 * **additive highlight emissive** beside its fade alpha -- `model+0x190/194/198`, setter `0x710d40`,
 * default `(0, 0, 0)` -- and the animate kernel adds it to the material emissive through
 * `glMaterialfv(GL_EMISSION)`. The mouseover publisher and the target setter push it on CHANGE with
 * `SetHighlight 0x614550` / `ClearHighlight 0x6144f0`, carrying a per-object REASON BITMASK: bit 0 is
 * target, bit 1 is mouseover, the two STACK, and the glow drops only when the last reason clears.
 * `SetHighlight` writes the config RGB, whose shipped default is `0xff404040`.
 *
 * Sources: `samples/benilla/crates/benilla/src/target/highlight.rs:1-19` and
 * `.../instance_tint.rs:5-10`, both citing wow-re `object-layer/scratch/selection-circle.md` PART 2
 * §5 ("cross-checked"). So the mechanism, the magnitude, the stacking rule and the push-on-change are
 * all the reference's. **What is OURS:** nothing about the value. The only choice made here is which
 * of this client's objects can carry it (see "Scope" below).
 *
 * ## It is a different thing from the selection ring, and both are true at once
 *
 * The ring is a projected decal that marks the TARGET (owner-confirmed, 0.0003 yd residual). This
 * marks whatever is under the POINTER. A unit that is both hovered and targeted gets one lift, not
 * two -- which is the reference's reason-bitmask collapsing to set membership, exactly as
 * `highlight.rs:14-17` describes ("an entity is lit while it is hovered *or* targeted -- same
 * stacking result"). Nothing here touches the ring.
 *
 * ## Why this writes the material uniform directly, and why that is the CHEAP arrangement
 *
 * A per-instance value feeding a shared material normally has to be pushed per draw, which is what
 * `pipeline/m2/submesh.js#applyFadeAlphaBeforeRender` does for the fade alpha: it walks up from each
 * batch mesh, every batch, every frame. Doing that for the highlight would put a second walk on every
 * batch of every doodad in the world to carry a value that is zero for all but one of them.
 *
 * It is not needed, because a UNIT owns its materials. `M2#clone` only shares `batches` when
 * `canInstance` is true, and that is false the moment any bone animates
 * (`pipeline/m2/index.ts:348-353`, `wow-data-parser/m2/index.js:169-179`) -- so every character and
 * every creature has private materials. Writing the uniform on them cannot reach another placement.
 * That is the same ownership argument `ui/scene/model-booth.ts#allowDestinationAlpha` makes, and it is
 * checked the same way rather than assumed: `ownsBatches`.
 *
 * The cost is therefore **one traverse of one model's submeshes on a hover CHANGE**, and exactly zero
 * per frame and zero for every model that is not lit. Pushing on change is also what the reference
 * does, so the cheap arrangement and the faithful one are the same one.
 *
 * ## It cannot dirty the interface
 *
 * This writes a uniform on world geometry. It sets no widget field, adds nothing to the UI draw list
 * and changes no sprite, so `world-ui.ts#drawListSignature` cannot see it -- the same argument that
 * made the selection ring and the nameplates cost zero extra dirty frames. Measured, not assumed; the
 * number is in the task report.
 *
 * ## What is lifted, and what is not -- both stated because they are choices of ours
 *
 * **THE BODY ONLY, NOT ITS ATTACHMENTS -- a declared gap, with the reason.** The reference lifts "every
 * lit material of the model *and* its attachments", and I wrote that a hovered unit's weapon and
 * shoulders would brighten with it. **They do not, and they never did:** `applyHighlight` walks
 * `model.submeshes`, and a helm, a pauldron or a weapon is parented to a BONE, so it is not in that
 * list. Correcting the claim rather than leaving it standing.
 *
 * It is not an oversight that is one line from fixed, either. An attached item is a static model, so
 * `canInstance` is true and `M2#clone` hands it the SOURCE's materials -- shared with every placement
 * of that item path in the world. Writing the lift there would brighten every copy of that helm on
 * every character in the zone, which is exactly the defect
 * `ui/scene/model-booth.ts#saveBorrowedLighting` had to undo for the booth's studio light. Covering
 * attachments needs the per-draw push this deliberately avoided (a parent walk per batch), scoped to
 * the hovered unit's own subtree; that is a real piece of work and it is not started.
 *
 * **Units only.** The reference brightens any hoverable `CGObject` with a model -- "GameObjects when they
 * become hoverable" (`highlight.rs:18-19`) -- and this client's pick resolves units and nothing else,
 * so there is no GameObject hover to answer yet. A doodad could not take this route anyway: a static
 * model IS instanceable, so its materials are shared with every other placement of its path and
 * lighting one would light them all. `applyHighlight` refuses that case out loud rather than doing it.
 */

/**
 * The lift, per channel, on the lighting sum.
 *
 * The shipped config default is `0xff404040`, and `0x40` is 64, so `64 / 255`. NOT a value of ours:
 * see the file header for the two reference files that carry it, and
 * `pipeline/m2/material/fragment/common-header.glsl` for where in the shading it is added and why that
 * placement is the whole of it.
 */
export const HIGHLIGHT_LIFT = 64 / 255;

/**
 * Push `lift` into every material of one model, and answer whether it could.
 *
 * Answers false for a model whose batches are SHARED (`ownsBatches !== true`) without writing
 * anything -- see the file header's scope note. A caller that gets false has asked for something this
 * route cannot do safely, and it is the caller's business to say so once rather than per frame.
 *
 * `uniformsNeedUpdate` is the load-bearing line, for the reason
 * `pipeline/m2/material/per-object-light.ts` already documents: three re-uploads a `ShaderMaterial`'s
 * uniforms only on a program swap or when this flag is set, so writing `.value` alone reaches the GPU
 * for nobody.
 */
export function applyHighlight(model: any, lift: number): boolean {
  if (!model) {
    return false;
  }
  if (model.ownsBatches !== true) {
    return false;
  }
  for (const submesh of model.submeshes ?? []) {
    for (const batch of submesh.children ?? []) {
      const uniform = batch?.material?.uniforms?.highlight;
      if (uniform === undefined) {
        continue;
      }
      if (uniform.value === lift) {
        continue;
      }
      uniform.value = lift;
      batch.material.uniformsNeedUpdate = true;
    }
  }
  return true;
}

/**
 * Which model is lit, and the two reasons that can light it.
 *
 * Holds the last set so a reason that clears puts the lift back exactly once -- `highlight.rs`'s own
 * `was_lit` local, for the same purpose. The two reasons are kept SEPARATELY and folded at the end,
 * because that is what makes a unit that stops being hovered while still being the target stay lit.
 */
export class HoverHighlight {
  private hovered: any = null;

  private targeted: any = null;

  /** The models currently carrying the lift, so exactly the ones that lose it get it cleared. */
  private lit: any[] = [];

  /** Models this route cannot light, reported once each rather than per hover. */
  private readonly refused = new WeakSet<object>();

  /** The unit under the pointer, or null. */
  setHovered(unit: any): void {
    if (this.hovered === unit) {
      return;
    }
    this.hovered = unit;
    this.sync();
  }

  /** The selected unit, or null. Hover and target STACK -- see the file header. */
  setTargeted(unit: any): void {
    if (this.targeted === unit) {
      return;
    }
    this.targeted = unit;
    this.sync();
  }

  /**
   * Re-push after a unit's model has been REPLACED.
   *
   * A redress or a display-id change hands the unit a fresh clone with fresh materials at zero, and
   * the hovered unit is the same object -- so `setHovered` would short-circuit and the new body would
   * stand unlit under the pointer until the pointer moved. The set is compared by MODEL, not by unit,
   * which is what makes this a plain re-sync rather than a special case.
   */
  refresh(): void {
    this.sync();
  }

  /**
   * Forget a unit that is LEAVING the world.
   *
   * Deliberately does not clear the lift: the caller is `World#remove`, whose next act is to release
   * the model, so writing zero into materials about to be disposed is work with nothing to show. What
   * matters is that neither this nor `lit` keeps the unit or its model alive.
   */
  forget(unit: any): void {
    if (this.hovered === unit) {
      this.hovered = null;
    }
    if (this.targeted === unit) {
      this.targeted = null;
    }
    const model = unit?.model ?? null;
    if (model !== null) {
      this.lit = this.lit.filter((entry) => entry !== model);
    }
  }

  /**
   * Drop every lift.
   *
   * NO CALLER TODAY, and the honest reason is that `World` has no teardown to call it from -- when a
   * world goes, this goes with it. Kept because `forget` covers one unit and this covers the state,
   * and because the day a world is torn down without being dropped, the alternative is a list holding
   * disposed models.
   */
  clear(): void {
    this.hovered = null;
    this.targeted = null;
    this.sync();
  }

  private sync(): void {
    // THE COMMON CASE IS NOTHING LIT AND NOTHING TO LIGHT, and `refresh()` is called from
    // `World#changeModel` -- i.e. once per unit stream-in and once per redress, for every unit in the
    // grid. Without this the pointer sitting over empty ground would still pay a walk of the whole
    // want/lit bookkeeping on each of them. Caught in this round's own diff review.
    if (this.hovered === null && this.targeted === null && this.lit.length === 0) {
      return;
    }
    const want: any[] = [];
    for (const unit of [this.hovered, this.targeted]) {
      const model = unit?.model ?? null;
      if (model !== null && !want.includes(model)) {
        want.push(model);
      }
    }
    for (const model of this.lit) {
      if (!want.includes(model)) {
        applyHighlight(model, 0);
      }
    }
    const lit: any[] = [];
    for (const model of want) {
      if (applyHighlight(model, HIGHLIGHT_LIFT)) {
        lit.push(model);
        continue;
      }
      // Named once per model. The only way here today is a hoverable whose model is instanceable,
      // which no unit is -- so this firing is news about the model, not about the pointer.
      if (!this.refused.has(model)) {
        this.refused.add(model);
        console.warn(
          `hover highlight: ${model.path ?? 'a model'} shares its materials with every other `
            + 'placement of its path (ownsBatches false), so it cannot be brightened without '
            + 'brightening all of them; it stays unlit under the pointer',
        );
      }
    }
    this.lit = lit;
  }
}
