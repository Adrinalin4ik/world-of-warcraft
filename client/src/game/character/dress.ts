/**
 * Build one character from a resolved `CharacterLook`: the `.m2`, the baked body composite, the geoset
 * selection, the three runtime texture slots, the standing loop and the attached item models.
 *
 * WHY THIS FILE EXISTS. Every line here was `GlueSceneView#setCharacter`, and it is now shared because
 * there is a second consumer: the player's own avatar in the world (`classes/unit.ts#setCharacterLook`).
 * The alternative was a copy, and a copy is the specific outcome the compositor's author already had to
 * resist -- texture types 1, 2 and 6 arrive through a single `updateCharacterTextures(body, hair, cape)`
 * on purpose, and a second dressing path would have drifted from this one at the first bug fixed in
 * only one of them.
 *
 * WHAT DID NOT MOVE, and why the split is here rather than one line up or down:
 *  - **Placement.** The glue stage sits the character on the stage asset's attachment 0 and yaws it
 *    from `SetCharacterSelectFacing`; the world sits it on the mover's `move.pos` and yaws it from
 *    `move.modelYaw`. Nothing is shared, so nothing is lifted.
 *  - **Cancellation.** The glue scene cancels on a roster click (`characterToken`), the world on a
 *    model replacement. Both are "is this load still wanted", and both are expressed as the
 *    `stillWanted` predicate below rather than as a token this file owns -- it cannot own one, because
 *    the two consumers count different events.
 *  - **Lighting and posing.** The glue scene solves its two models itself; the world runs every unit
 *    through the pose gate and the visibility manager. Same reason.
 *
 * WHAT IS DELIBERATELY NOT HERE: nothing throttles. `loadCharacter` is one `.m2` fetch plus one bake,
 * and a world with many players will run many of them. The bake is measured at 4.7 ms naked / 6.3 ms
 * dressed on the main thread (`docs/superpowers/research/2026-08-07-compositor-measurements.md` §5) and
 * the SOURCES are the expensive half at p50 57 ms cold each. A budget belongs to whoever decides which
 * characters are worth drawing -- see the report's cost section.
 */
import M2Blueprint from '../pipeline/m2/blueprint';
import { failedTexturePaths, TextureFailure } from '../pipeline/m2/material';
import { worldClock } from '../pipeline/m2/anim/world-clock';
import { cachedComposite } from '../ui/scene/body-composite';
import { CharacterLook } from '../ui/scene/character-look';

/**
 * `AnimationData.dbc` id 0 -- Stand. The same id `classes/unit.ts` arms a freshly loaded unit with and
 * the id `ModelAnim#resolve` falls back to for anything a model does not carry.
 */
export const STAND_ANIMATION_ID = 0;

/** What `loadCharacter` hands back: the cloned body model and the bake, either of which may be null. */
export type LoadedCharacter = {
  model: any;
  composite: Awaited<ReturnType<typeof cachedComposite>>;
};

/**
 * Fetch the body `.m2` and bake the body composite, in parallel.
 *
 * IN PARALLEL, not in sequence, and that is a measurement rather than a style: the composite's sources
 * are 6-16 independent HTTP fetches through the same worker pool the `.m2` uses, measured at p50 57 ms
 * each cold against 1.3 ms to decode one, so awaiting them after the model would add the whole fetch to
 * the time before anything is drawn.
 *
 * THE BAKE ARM CANNOT BE ALLOWED TO REJECT. `Promise.all` rejects as a whole, and this pair is what
 * owns the loaded `.m2`: a rejection would skip every caller's handler, so the model would neither be
 * added to a scene nor unloaded -- a leak plus an invisible character, for a texture problem.
 * `compositeBody` already answers null for every failure it can name; the catch is for the one it
 * cannot.
 */
export function loadCharacter(look: CharacterLook): Promise<LoadedCharacter> {
  return Promise.all([
    M2Blueprint.load(look.modelPath),
    cachedComposite(look.compositeKey, look.bodyLayers).catch((error) => {
      console.warn('character: the body composite threw; falling back to the raw skin', error);
      return null;
    }),
  ]).then(([model, composite]) => ({ model, composite }));
}

/**
 * Apply everything about a look that lives on the body model itself: scale, geosets, the three runtime
 * texture slots and the standing loop.
 *
 * `applyScale` exists because the two consumers disagree about who owns the matrix. The glue scene owns
 * it outright. In the world, `Unit`'s `model` setter writes `m2.rotation.z = Math.PI` and calls
 * `updateMatrix()` itself, so the scale has to be composed with that rather than overwrite it -- and
 * `model.scale.setScalar()` is **inert** under `matrixAutoUpdate = false`, which `M2` sets on itself
 * (`pipeline/m2/index.ts:163`). A missing `updateMatrix()` silently drew gnomes at human size for
 * several rounds, and a world is full of non-human races, so the call is made here and its necessity is
 * stated at both call sites.
 *
 * ANSWERS A PROMISE, and everything except the texture slots has already happened by the time it is
 * returned -- scale, geosets and the Stand are synchronous. The promise is the THREE TEXTURE SLOTS
 * settling, and it exists because they used to settle into a setter that could tell nobody. It never
 * rejects (see `M2Material#loadTextures`) and it reports its own failures, so a caller that cannot
 * usefully wait may drop it; a caller inside a promise handler should RETURN it, which is what stops
 * bluebird warning that a promise was created in a handler and not returned from it.
 */
export function applyCharacterLook(
  model: any,
  look: CharacterLook,
  loaded: LoadedCharacter,
): Promise<void> {
  model.scale.setScalar(look.scale);
  model.updateMatrix();

  // A character `.m2` carries every hairstyle, glove, boot and cloak at once -- 61 submeshes on
  // `humanmale00.skin` for 54 geoset ids. Without this the body wears all of them simultaneously.
  model.setVisibleGeosets(look.geosets);

  // Texture slots 1 (body), 6 (hair) and 2 (cloak), in one supply.
  //
  // The body slot takes the baked COMPOSITE -- a texture this process owns, not a path -- which is why
  // `M2Material#loadTextures` accepts a texture there without going through `TextureLoader`.
  // `look.bodyTexture` (the raw base skin path) is the fallback for a bake that could not happen at
  // all: no base row, a fetch that failed, or a compressed base skin. It draws the blank-faced body
  // that shipped before the compositor, which is a worse picture but not a wrong one.
  //
  // `hairTexture` is null for a bald look -- `CharSections` BaseSection 3 VariationIndex 0 carries
  // empty strings and there is no hair mesh to sample them -- so that is the right value, not a missed
  // assignment.
  const composite = loaded.composite;
  const body = composite?.texture ?? look.bodyTexture;
  if (composite) {
    console.debug(
      `character: composited ${composite.layers} layers in ${composite.bakeMs.toFixed(1)} ms ` +
        `(sources ${composite.fetchMs.toFixed(1)} ms)`,
    );
  } else if (look.bodyLayers.length > 0) {
    console.warn('character: the body composite could not be baked; binding the raw base skin');
  }
  if (!body && !look.hairTexture && !look.capeTexture) {
    // Nothing to supply at all -- a bake that produced nothing for a look that names no hair and no
    // cloak. Not a failure: the model draws its authored textures.
    return Promise.resolve();
  }

  // THROUGH THE METHOD, and the promise is RETURNED. `model.characterTextures = ...` was a setter,
  // and a setter cannot hand back the texture loads it starts -- so this function reported a
  // character dressed before its body, hair and cloak existed, and a 404 on any of them reached
  // nobody here. `M2#setCharacterTextures` answers the failures instead; see
  // `M2Material#loadTextures` for why it resolves with them rather than rejecting.
  return model
    .setCharacterTextures({ body, hair: look.hairTexture, cape: look.capeTexture })
    .then((failures: TextureFailure[]) => {
      if (failures.length === 0) {
        return;
      }
      // The material has already put one `Failed to load M2 texture` line per file on the console.
      // This one says WHOSE they were, which is the thing only the call site knows.
      const paths = failedTexturePaths(failures);
      console.warn(
        `character: ${look.modelPath} is dressed but ${paths.length} of its texture files did ` +
          `not load: ${paths.join(', ')}`,
      );
    });
}

/**
 * Arm the looping Stand.
 *
 * Through `resolve` and not a raw slot: `resolve` follows the alias chain and falls back to the first
 * sequence whose keyframes are actually in the `.m2`. Measured on `humanmale.m2`: 156 sequences, 104
 * with inline keys and 52 external (`.anim` siblings), and AnimationData id 0 has four variations in
 * slots 0, 22, 23 and 136, all inline, all flags 0x20 -- so bit 0 is clear and `sequenceLoops` makes
 * them loops. Slot 0, length 2667 ms, is what `resolve(0)` lands on.
 *
 * SKIPPED IN THE WORLD, where `Unit`'s `model` setter already arms `currentAnimationId` and the gait
 * driver owns the body from the next frame on. Arming here as well would be harmless but would say two
 * things own the same clock; the glue scene has no gait driver and so needs this.
 */
export function armStand(model: any, modelPath: string): void {
  const sequence = model.modelAnim?.resolve?.(STAND_ANIMATION_ID) ?? null;
  if (sequence && model.instanceAnim) {
    model.instanceAnim.arm(sequence, worldClock.ms);
  } else {
    console.warn(`character: ${modelPath} has no playable Stand sequence; it stands in bind pose`);
  }
}

/**
 * Hang the look's item models on the body's bones -- weapons, a shield, the shoulder pair, the helm.
 *
 * AFTER the body exists and not beside it in a `Promise.all`, because every attachment's destination is
 * a bone of a model that has to be there first: `M2#attachTo` reads the body's own attachment table. So
 * the body appears as soon as it lands and the weapon follows it a frame or three later, rather than
 * both waiting for the slowest fetch.
 *
 * Each item is loaded independently rather than through one `Promise.all`, so one 404 (a texture family
 * that ships under a name the DBC does not spell) costs its own model and not the others.
 *
 * `stillWanted` is re-checked inside every arm: an attachment fetch is exactly as cancellable as the
 * body's was, and a roster click or a model replacement during it would otherwise hang the previous
 * character's sword on the new character's hand -- or on nothing at all. `onAttached` is how the caller
 * records what it must later release: `M2Blueprint.unload` is a reference-counted release against a
 * path and the scene graph cannot be walked for it.
 */
export function attachCharacterItems(
  body: any,
  look: CharacterLook,
  stillWanted: () => boolean,
  onAttached: (model: any) => void,
): void {
  for (const item of look.attachments) {
    M2Blueprint.load(item.modelPath)
      .then((model: any) => {
        if (!stillWanted()) {
          M2Blueprint.unload(model);
          return;
        }
        if (!body.attachTo(item.attachId, model)) {
          // Not an error and not a guess: the reference's world path has the same rule -- "the body has
          // no such attach point -- hold nothing" (`attach/glue_preview.rs:325-326`). It cannot fire for
          // the six ids in use on any playable 3.3.5a character (all six were dumped out of
          // `HumanMale.m2`), so if it ever does, the model is the news.
          console.warn(
            `character: ${body.name ?? 'the body'} has no attachment ${item.attachId} for ` +
              `${item.kind} -- ${item.modelPath} draws nothing`,
          );
          M2Blueprint.unload(model);
          return;
        }
        onAttached(model);
        // `M2` constructs itself hidden. On the glue stage there is no visibility manager to turn it
        // on; in the world the manager only knows about placements it registered, and a bone child is
        // not one -- three's `projectObject` returns before walking children of a hidden node, so an
        // unset flag here hides the weapon for ever.
        model.visible = true;
        // Texture type 2, the item model's only runtime slot. Null when the row names no texture,
        // which leaves the shared `PLACEHOLDER` -- a visibly flat item rather than a missing one,
        // and NOT a failure: `M2Material#resolveTexturePath` answers null for it and no fetch is
        // made, so `failures` below stays empty.
        //
        // RETURNED FROM THIS HANDLER, which is the whole of the bluebird warning this replaced:
        // `model.objectTexture = ...` was a setter, so the texture loads it started belonged to
        // nobody -- the item was reported attached before its skin existed and the `.catch` below
        // covered only the MODEL fetch. Returning the promise puts the texture inside this item's
        // own chain.
        return model
          .setObjectTexture(item.texturePath)
          .then((failures: TextureFailure[]) => {
            if (failures.length === 0) {
              return;
            }
            // One line per file is already on the console from the material. This one names the
            // item, which is what makes it actionable -- and it stays a WARN because the item is
            // attached and drawn, with the placeholder skin, rather than missing.
            console.warn(
              `character: ${item.kind} ${item.modelPath} is attached but its texture ` +
                `${failedTexturePaths(failures).join(', ')} did not load; it draws flat`,
            );
          });
      })
      .catch((error) => {
        console.warn(`character: ${item.modelPath} did not load`, error);
      });
  }
}
