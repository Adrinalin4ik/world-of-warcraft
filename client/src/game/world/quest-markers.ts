import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';
import { worldClock } from '../pipeline/m2/anim/world-clock';
import { DIALOG_STATUS } from '../../network/game/object/quest';
import type Unit from '../classes/unit';

/**
 * THE `!` AND `?` OVER A QUESTGIVER'S HEAD.
 *
 * **It is not a sprite. It is one of the client's own M2 models, parented to a bone on the NPC's
 * body.** That is the reference's central finding (`benilla-app/src/quest_markers/mod.rs:12-20`) and
 * it is why this file lives beside the world's other model work rather than anywhere near the
 * interface: there is no UI band involved, so the nameplate layering question --
 * `PLATE_RENDER_CEILING`, the floating combat text above it -- does not arise at all.
 *
 * ## THE RENDER LAW, taken from the reference and re-checked against 3.3.5a
 *
 * The MECHANISM is the reference's, byte-verified there against 1.12: an M2 child at an attachment
 * slot, a one-time scale that cancels the attach basis, and the status map choosing the model. Every
 * NUMBER and PATH below was re-checked against this build's own served data, because that is exactly
 * the class of value that has moved between versions a dozen times in this project.
 *
 * **Attachment slot 18 (0x12)** -- `mod.rs:14-17`. Taken as-is, and safely: it is a slot INDEX into
 * the model's own attachment table and `M2#attachTo` looks it up by `id` rather than by position, so
 * a model that does not carry 18 answers false and this file renders nothing for that unit. That is
 * the reference's own behaviour ("no slot => created but never parented -- invisible; we render
 * nothing"), which is why there is no fallback bone here. Slot 29's mount branch is not implemented
 * because this client has no mounts.
 *
 * **The models are SIX, and the names came from the reference after fifteen guesses had failed.**
 * `interface/buttons/` answers 200 for `talktome.m2` (15,680 B), `talktomequestionmark.m2` (17,952),
 * `talktomegrey.m2` (15,664), `talktomeblue.m2`, `talktomequestion_grey.m2` (17,936) and
 * `talktomequestion_ltblue.m2` (17,936).
 *
 * **The two `?` variants were nearly written off as unserved, and that is the lesson here.** Fifteen
 * plausible spellings were probed and 404ed -- `talktomeq`, `talktomegray`, `talktomegold`,
 * `talktomeexclaim`, `talktomered`, `talktomeactive`, `talktomecomplete`, `talktomelowlevel`,
 * `talktome_q`, `talktomeblu`, `talktomedone` and four grey-question-mark spellings including
 * `talktomequestionmarkgrey` and `talktomegreyquestionmark` -- and this header duly concluded that no
 * grey question mark existed on this build, with the low-level turn-in taking the grey exclamation as a
 * named substitution. **All of it was wrong, and only the underscore was.** The reference names both
 * files outright (`mod.rs:126-127`), the host answers 200 for each and for its `.skin`, and reading the
 * reference's map first would have replaced the whole guessing round with one line.
 *
 * The sizes corroborate the pairing without opening a skin: 15,664-15,680 B is the `!` glyph and 17,936
 * -17,952 B the `?`, so the family is two glyphs under four texture ramps. The ramps were read out of
 * each model's own texture block -- `INTERFACE\BUTTONS\YELLOWORANGE64.BLP` for both gold ones,
 * `SPELLS\GRAD1A.BLP` for both grey ones, `GRADBLUE.BLP` for the light-blue `?` -- which is what makes
 * "grey `?`" a read rather than an inference. `talktomeblue.m2` and `talktomegreen.m2` are the `!` glyph
 * in blue and green and stay unused: the reference drives those off NPC flags, not off this status
 * packet (`mod.rs:120-122`), and this client has no taxi handler to feed the green one.
 *
 * ## THE SCALE IS A SNAPSHOT, AND WAITING FOR PROPAGATION IS THE WHOLE OF IT
 *
 * `1 / ||row0 of the attach bone's world matrix||`, computed ONCE and baked into the marker's own
 * matrix (`mod.rs:19-20`). Not distance-based, not unit scale, no clamp and no floor.
 *
 * **The reference documents having been bitten by the timing, and this file is written against it.**
 * The compensation reads the parent's matrix *as it stands at attach*; if the body model is still
 * streaming the parent is still identity, `L` comes out ~1, and there is **no counter-scale at all**
 * -- the marker ends up proportional to the unit instead of constant, permanently, because nothing
 * re-runs the bake. It is invisible at scale 1, which is why it goes unnoticed (`mod.rs:22-48`, the
 * case A / case B table).
 *
 * So the bake is DEFERRED until the bone's world matrix has actually propagated. This client sets
 * `scene.matrixWorldAutoUpdate = false`, so a bone's `matrixWorld` is only meaningful after the
 * world's own matrix pass has run: a marker attached on one frame is baked on a later one, once its
 * bone reports a written, non-degenerate basis. The reference reaches the same state by a different
 * route ("benilla is case B by construction: `bake_seat_scale` deliberately waits for propagation")
 * and records that the resulting look was confirmed against the real client BY EYE rather than by
 * argument -- so a gnome-sized `?` over a huge NPC is correct and must not be "fixed" by dropping the
 * counter-scale.
 *
 * ## THE ANIMATION, and what is NOT built
 *
 * The reference arms the marker's own M2 looping: sequence **0** normally, sequence **190** while the
 * unit has a live overhead name, the two holding the same three-key bob at different heights -- 190
 * is the authored push-up that lifts the marker clear of the name text (`mod.rs:60-67`).
 *
 * **Sequence 0 is armed here; 190 is a declared gap.** Choosing between them needs a per-unit answer
 * to "is an overhead name showing", which is the nameplate system's state and not this file's, and
 * the cost of getting it wrong is a marker drawn through the name text. Named rather than guessed,
 * and it is one condition away from complete.
 *
 * ## COST
 *
 * **Zero UI draw-fingerprint by construction**, for the reason `selection-ring.ts` states about
 * itself: these are models in the world scene, and `drawListSignature` mixes interface draw items and
 * cannot see them. Per frame the work is a walk over the live markers -- a handful, one per
 * questgiver in view -- plus one `Matrix4` row norm for any still awaiting its bake.
 */

/** `Interface\Buttons\TalkToMe*`, lowercased for the case-sensitive host. See the header. */
const MODEL = {
  available: 'interface\\buttons\\talktome.m2',
  reward: 'interface\\buttons\\talktomequestionmark.m2',
  lowLevel: 'interface\\buttons\\talktomegrey.m2',
  /**
   * Grey `?` -- a quest held and NOT yet finished. The `?` glyph on the same grey ramp the grey `!`
   * uses (`SPELLS\GRAD1A.BLP`, read off both models' texture blocks), and 17936 bytes against the gold
   * `?`'s 17952 -- the same glyph, a different ramp.
   *
   * A comment here previously concluded no grey question mark is served on this build. That was wrong,
   * and only the SPELLING was: the reference names the file outright as `TalkToMeQuestion_Grey.m2`
   * (`samples/benilla/crates/benilla-app/src/quest_markers/mod.rs:126`) -- the underscore is the part
   * every guess had missed. The host answers 200 for it and for its `.skin`.
   */
  greyReward: 'interface\\buttons\\talktomequestion_grey.m2',
  /**
   * Light-blue `?` -- a reputation turn-in. `INTERFACE\BUTTONS\GRADBLUE.BLP`, the `?` glyph, named by
   * the same reference line (`:127`) and served the same way.
   */
  blueReward: 'interface\\buttons\\talktomequestion_ltblue.m2',
} as const;

/**
 * Attachment slot for an overhead marker. The reference's `18` (0x12), used as a slot INDEX and
 * looked up by id, so a model without it renders nothing rather than falling back. See the header.
 */
export const MARKER_ATTACHMENT = 18;

/**
 * `DIALOG_STATUS` -> which model, or null for no marker.
 *
 * **The map is the reference's, translated status-by-status BY NAME** -- `quest_markers/mod.rs:118-131`
 * lists it as `UNAVAILABLE -> grey !`, `INCOMPLETE -> grey ?`, `REWARD_REP -> light-blue ?`,
 * `AVAILABLE -> gold !`, `REWARD_OLD/REWARD2 -> gold ?`. Its NUMBERS are 1.12's and are not reused:
 * `INCOMPLETE` is 3 there and **5** here, `REWARD_REP` 4 there and **6** here, `AVAILABLE` 5 there and
 * **8** here. Every case below names our own 3.3.5a enum member, so the translation is the compiler's
 * problem rather than a literal anyone has to keep in step.
 *
 * The three `LOW_LEVEL_*` values (2, 3, 4) have no counterpart in the reference -- 1.12 does not send
 * them. They are read by name: the two `*_AVAILABLE*` ones are an offer below the player's level, which
 * is what the grey `!` is for, and `LOW_LEVEL_REWARD_REP` is a turn-in below it, which is the grey `?`.
 * `NONE` alone draws nothing.
 *
 * So the pair the owner asked for reads directly off this table: a held quest is a **grey `?`** while
 * `INCOMPLETE` and a **gold `?`** once the server moves it to `REWARD`, and an offer is a **gold `!`**
 * when it is takeable and a **grey `!`** when it is not yet.
 */
export function modelFor(status: number): string | null {
  switch (status) {
    case DIALOG_STATUS.AVAILABLE:
    case DIALOG_STATUS.AVAILABLE_REP:
      return MODEL.available;
    case DIALOG_STATUS.REWARD:
    case DIALOG_STATUS.REWARD2:
      return MODEL.reward;
    case DIALOG_STATUS.REWARD_REP:
      return MODEL.blueReward;
    case DIALOG_STATUS.INCOMPLETE:
    case DIALOG_STATUS.LOW_LEVEL_REWARD_REP:
      return MODEL.greyReward;
    case DIALOG_STATUS.UNAVAILABLE:
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE:
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE_REP:
      return MODEL.lowLevel;
    default:
      return null;
  }
}

/** One live marker. */
interface Marker {
  path: string;
  model: THREE.Object3D & { updateMatrix?: () => void };
  /** False until the attach basis has propagated and `1/L` has been baked. See the header. */
  baked: boolean;
}

type MarkerHost = {
  attachTo?: (id: number, child: THREE.Object3D) => boolean;
} | null;

type Armable = {
  modelAnim?: { resolve: (id: number) => unknown };
  instanceAnim?: { arm: (seq: never, ms: number) => void } | null;
};

export class QuestMarkers {
  /** guid -> its marker. */
  private live = new Map<string, Marker>();

  /** Guids whose load is in flight, so a slow fetch cannot start a second one. */
  private loading = new Set<string>();

  /**
   * THE MAP'S LIGHT AND FOG REGISTRY, handed in by the world -- and without it a marker renders WHITE.
   *
   * Not a nicety: `world/index.ts#adoptAttachedModel` documents this exact failure for helms, pauldrons
   * and weapons, and a marker is the same kind of thing. Nothing else hands an attached model's materials
   * their fog uniforms, so `fogParams` stays `(0,0,0,0)` and `fogColor` keeps its constructor default --
   * and `new THREE.Color()` is white. The shader's `f4 = min(max(d*0 + 0, 0), 1)` is then 0, so
   * `fogFactor` is 1, and `applyFog` does `mix(color.rgb, fogRgb, 1.0)`: the fragment is replaced by that
   * white outright, at every distance, whatever the texture says.
   *
   * CONFIRMED here the same way it was for the armour, by the owner: `worldQuestMarkersFog = false` made
   * the marker yellow, and the measured inputs ruled the geometry out first -- `trueDistance=53.3`,
   * `viewDepth=19.5`, world position exactly the NPC's head. Small, sane, and fogged solid, which only
   * zeroed parameters can do.
   *
   * Injected rather than imported so this class keeps knowing nothing about the map.
   */
  adoptMaterials: ((model: unknown) => void) | null = null;

  releaseMaterials: ((model: unknown) => void) | null = null;

  private announcedPending = false;

  private pendingFrames = 0;

  /** `window.worldQuestMarkers()` reads this. `noSlot` is the reference's render-nothing case. */
  public stats = {
    attached: 0, baked: 0, pending: 0, noSlot: 0, dropped: 0,
  };

  /** How many markers are live. For the instrument. */
  public get liveCount(): number {
    return this.live.size;
  }

  /**
   * Reconcile the live markers against the server's status map.
   *
   * `statuses` is `QuestHandler#status` -- the guid -> `DIALOG_STATUS` map the two
   * `SMSG_QUESTGIVER_STATUS*` opcodes fill.
   */
  update(entities: Map<string, Unit>, statuses: Map<string, number>): void {
    // Drop first: a unit that left view, lost its status, or now wants a different model.
    for (const [guid, marker] of Array.from(this.live)) {
      const unit = entities.get(guid);
      const wanted = unit === undefined ? null : modelFor(statuses.get(guid) ?? 0);
      if (wanted === null || wanted !== marker.path) {
        this.detach(guid, marker);
      }
    }

    for (const [guid, status] of statuses) {
      const path = modelFor(status);
      if (path === null || this.live.has(guid) || this.loading.has(guid)) {
        continue;
      }
      const unit = entities.get(guid);
      // The host needs a model with a skeleton in the scene -- `attachTo`'s own precondition.
      if (unit === undefined || !unit.model) {
        continue;
      }
      this.attach(guid, unit, path);
    }

    // THE DEFERRED BAKE. See the header: reading the basis before the world matrix pass has
    // propagated gives L ~= 1 and no counter-scale at all, permanently.
    let pending = 0;
    for (const marker of this.live.values()) {
      if (marker.baked) {
        continue;
      }
      if (this.bake(marker)) {
        this.stats.baked += 1;
      } else {
        pending += 1;
        /**
         * THE BAKE THAT NEVER HAPPENS, and it is the one remaining silent state.
         *
         * `bake` refuses while the attach bone's world matrix has not propagated -- an all-zero
         * translation -- and this world deliberately does NOT auto-update world matrices
         * (`scene.matrixWorldAutoUpdate = false`, worth 6 ms a frame). If nothing ever walks the graph
         * for a newly parented child, the refusal is permanent and the marker sits at scale 1 wherever
         * an identity matrix puts it. Counted in frames rather than announced immediately, because the
         * first few updates legitimately arrive before propagation.
         */
        this.pendingFrames += 1;
        if (this.pendingFrames === 120 && !this.announcedPending) {
          this.announcedPending = true;
          const bone = marker.model.parent;
          const m = bone === null ? null : bone.matrixWorld.elements;
          // eslint-disable-next-line no-console
          console.warn('questmarkers: bake STILL PENDING after 120 updates -- bone world matrix '
            + `pos=${m === null ? 'no parent'
              : `${m[12].toFixed(1)},${m[13].toFixed(1)},${m[14].toFixed(1)}`}`);
        }
      }
    }
    this.stats.pending = pending;
  }

  private attach(guid: string, unit: Unit, path: string): void {
    this.loading.add(guid);
    /**
     * ANNOUNCED BEFORE THE AWAIT, and the placement is the whole point of this line.
     *
     * The first version of this diagnostic logged inside `.then()`, and the owner's console then showed
     * the feed line and nothing else -- which is consistent with two completely different things: the
     * attach never being reached, or `M2Blueprint.load` never settling. This client already has one
     * recorded instance of the second (the level-up burst's model load never settles while its page
     * fetch answers 200), so the two had to be told apart rather than assumed.
     *
     * So: this line means the attach started. `resolved` below means the load came back. Their absence
     * or presence is now a three-way answer instead of a one-way hint.
     */
    void M2Blueprint.load(path)
      .then((model: THREE.Object3D & { updateMatrix?: () => void }) => {
        this.loading.delete(guid);
        const host = unit.model as unknown as MarkerHost;
        // The unit may have gone, or been re-modelled, while the fetch was out.
        if (host === null || typeof host.attachTo !== 'function' || this.live.has(guid)) {
          // Previously a silent exit. It is a real outcome -- the unit was re-modelled or gone while
          // the fetch was out -- and indistinguishable from every other silence without a line.
          // eslint-disable-next-line no-console
          console.log(`questmarkers: dropped after load ${guid} -- host or liveness changed`);
          M2Blueprint.unload(model as never);
          return;
        }
        if (!host.attachTo(MARKER_ATTACHMENT, model)) {
          // NO SLOT means NO MARKER -- the reference's own behaviour, not a fallback to another bone
          // or to a world-space position. Counted so the instrument can say how often.
          this.stats.noSlot += 1;
          // eslint-disable-next-line no-console
          console.log(`questmarkers: NO SLOT ${MARKER_ATTACHMENT} on ${guid}'s model -- no marker`);
          M2Blueprint.unload(model as never);
          return;
        }
        /**
         * **`M2` CONSTRUCTS ITSELF HIDDEN, and this one line is the whole of "значка всё ещё нет".**
         *
         * Everything else about this marker was already right, and the owner's own console proved each
         * step: 13 statuses matched to 13 entities, the correct model
         * (`talktomequestionmark.m2`) loading, `attachTo` returning true against attachment 18,
         * `attached=1 noSlot=0`, and finally `BAKED -- scale=1.0000, bone world pos=-8902.6,-162.7,84.2`
         * -- a real Northshire position, so the bone had propagated and the counter-scale was correctly
         * 1. State right at every stage, and not one pixel: this project's own recorded signature, and
         * the answer was the LAST HOP again.
         *
         * `character/dress.ts:230-233` had the rule written down for exactly this case: "in the world the
         * manager only knows about placements it registered, and a bone child is not one -- three's
         * `projectObject` returns before walking children of a hidden node, so an unset flag here hides
         * the weapon for ever." A marker is a bone child too, so it needs the same line for the same
         * reason. Missing it is invisible to every check short of looking at the screen.
         */
        model.visible = true;
        /**
         * THE FOG CONTROL ARM -- `window.worldQuestMarkersFog = false` and reload.
         *
         * A MEASUREMENT, not a fix, and the reasoning it tests is this. The fragment shader mixes an
         * opaque batch toward the FOG COLOUR after lighting (`fragment/common-header.glsl:234`), and the
         * mix is zeroed only for geometry flagged unfogged (render flag 0x02). This model's flags are
         * 0x41 -- unlit, and NOT unfogged -- so it is fogged by the game's own data, correctly.
         *
         * Which should be harmless at arm's length, because the factor falls to zero near the camera. But
         * a marker is the only thing in this client whose vertices are skinned against its OWN skeleton
         * while that skeleton hangs off another model's bone, so if the shader's camera distance comes
         * from a position that does not carry the host's transform, the distance is the whole map and the
         * fog is full -- which paints the glyph FLAT FOG COLOUR. Northshire's is pale, and pale flat is
         * exactly what the owner sees, with the shape still legible because the shape is geometry.
         *
         * Everything else is already eliminated by his own console: the texture is bound and 64x64 in the
         * material being drawn, `texCount` is 1, and `materialParams` reads `[1,0,1,1]` -- whose second
         * component is this shader's lighting switch, so the batch is genuinely unlit. Texture present,
         * light white, and still not yellow leaves the term applied after both.
         *
         * So: flip the arm. Yellow means the fog term is the cause and the fix belongs in how a
         * bone-parented model reports its camera distance -- not here. Still pale means fog is exonerated
         * and I am wrong again, which is worth knowing in one sighting rather than three.
         */
        if ((window as unknown as Record<string, unknown>).worldQuestMarkersFog === false) {
          (model as unknown as THREE.Object3D).traverse((node) => {
            const mat = (node as unknown as { material?: unknown }).material;
            const list = Array.isArray(mat) ? mat : [mat];
            list.forEach((one) => {
              const u = (one as { uniforms?: Record<string, { value?: unknown }> } | null | undefined)
                ?.uniforms;
              if (u?.fogModifier !== undefined) {
                u.fogModifier.value = 0;
              }
            });
          });
        }
        /**
         * NO PRIORITY RAISE HERE, AND THE REVERT IS THE POINT.
         *
         * I added one -- `M2Material#raiseToCharacterPriority` -- on the reasoning that a marker's
         * `type = 0` textures never leave `BACKGROUND` because no runtime setter is ever called for
         * them. The owner said the direction did not convince him, and he was right twice over.
         *
         * First, the evidence says the fetch was never the problem: with the report in place his console
         * gave `texture fetch SETTLED with 0 failure(s)`. The file arrives and decodes.
         *
         * Second, the raise could have CAUSED the symptom it was meant to cure. `loadTextures` REPLACES
         * the texture array rather than filling the existing one, and its own doc says it "does NOT
         * release the array it replaces" -- so a second call can leave the shader's uniform pointing at
         * the first array, whose slot then holds the shared placeholder for ever. That is a plausible
         * mechanism for a permanently white marker, which is exactly what was being chased.
         *
         * The lesson is the one this project already writes down: a fix that is reasonable in the
         * abstract and unmeasured is a guess, and this one also generated bluebird "promise created in a
         * handler but not returned" warnings in his console. Reverted rather than kept "because it
         * cannot hurt".
         */
        // The marker's own bob, armed looping. Sequence 0; see the header on why 190 is a gap.
        const armable = model as unknown as Armable;
        const seq = armable.modelAnim?.resolve(0);
        if (seq && armable.instanceAnim) {
          armable.instanceAnim.arm(seq as never, worldClock.ms);
        }
        // BEFORE the live registration, so a marker is never in `live` with unregistered materials --
        // one frame of that is one frame of solid fog colour.
        this.adoptMaterials?.(model);
        this.live.set(guid, { path, model, baked: false });
        this.stats.attached += 1;
        // ATTACHED, said outright. `attachTo` returning true is the point past which every remaining
        // failure is invisible from the outside -- the model is in the scene graph and simply does not
        // appear -- so this and the bake lines below are the only way to tell them apart.
        /**
         * THE MATERIALS, ONCE. The marker now DRAWS -- and white, where its own texture is a pure
         * yellow-to-orange ramp.
         *
         * Verified off the game's own files before instrumenting: `talktome.m2` declares ONE texture,
         * `type = 0` (the name lives in the model, not supplied at runtime),
         * `INTERFACE\BUTTONS\YELLOWORANGE64.BLP`; the host serves it lowercase and
         * `net/loader.js#normalizePath` lowercases every fetch; the BLP is `BLP2`, DXT1, 64x64, opaque,
         * and its blocks decode to (255,255,0) fading to (255,109,0) -- no white anywhere. The model
         * carries NO vertex-colour block, so the colour can only come from that texture, and the glyph
         * shape comes from the GEOMETRY -- which is why an untextured mesh reads as a white `!` rather
         * than a blank quad.
         *
         * So the question is whether a map is bound at all, and that is a property of the loaded model
         * rather than of anything this file does. Reported here rather than guessed at.
         */
        // eslint-disable-next-line no-console
        console.log(`questmarkers: ATTACHED ${guid}; live=${this.live.size} `
          + `attached=${this.stats.attached} noSlot=${this.stats.noSlot}`);
      })
      .catch((error: unknown) => {
        this.loading.delete(guid);
        // eslint-disable-next-line no-console
        console.log(`questmarkers: model ${path} failed to load -- no marker`, error);
        // `M2Blueprint.load` logs its own failure. A missing marker model is a missing marker.
      });
  }

  /**
   * Bake `1/L` once the attach basis has propagated. Returns whether it was done.
   *
   * `L` is the row-0 norm of the attach bone's WORLD matrix, so the compensation cancels the whole
   * attach basis -- the unit's model scale and any bone-chain scale alike (`mod.rs:24-26`).
   *
   * The propagation test is the honest part. Before the world's matrix pass has reached this bone its
   * `matrixWorld` is still the identity it was constructed with, and `L` reads ~1 -- which is
   * indistinguishable from a genuinely unscaled host. So this waits for a `matrixWorld` that has
   * actually been WRITTEN, and a non-zero translation is the tell: every unit in this world is placed
   * somewhere, so a bone still sitting exactly at the world origin has not been propagated yet. A
   * unit that never propagates never gets its marker scaled, which is better than one baked wrong and
   * permanent.
   */
  private bake(marker: Marker): boolean {
    const bone = marker.model.parent;
    if (bone === null) {
      return false;
    }
    const m = bone.matrixWorld.elements;
    if (m[12] === 0 && m[13] === 0 && m[14] === 0) {
      return false;
    }
    const length = Math.hypot(m[0], m[1], m[2]);
    if (!Number.isFinite(length) || length <= 1e-6) {
      return false;
    }
    marker.model.scale.setScalar(1 / length);
    // `M2` sets `matrixAutoUpdate = false` on itself, so `scale.setScalar` is INERT without this --
    // the trap `unit.ts#applyRenderScale` and `world/level-up-effect.ts` both record.
    if (typeof marker.model.updateMatrix === 'function') {
      marker.model.updateMatrix();
    }
    marker.baked = true;
    return true;
  }

  /**
   * THE MARKERS' OWN PER-FRAME PASS -- and its absence is why the `?` does not turn to face you.
   *
   * The owner: "вопросительный знак не направляется лицом ко мне". He is right, and the reason is
   * structural rather than a wrong angle: `world/index.ts`' animation loop walks the world's own MODELS
   * and calls `applyBillboards` on each (`:1506-1508`). A marker is a separate `M2` parented to a BONE of
   * one of those models, so it is in no such collection and nothing ever visits it. Its billboarded bones
   * therefore keep their bind rotation for ever, and its own bob never advances either.
   *
   * The reference drives exactly this and names it: `face_billboards` writes absolute world transforms
   * for the marker's billboarded submeshes, off the same clock its bob is armed against
   * (`benilla-app/src/quest_markers/mod.rs:385-400`).
   *
   * GATED ON `cameraMoved`, like the world's own pass, and skipped entirely for a model with no
   * billboarded bones -- so a marker costs nothing on a frame where the camera is still, and the whole
   * pass is a walk over at most a handful of live markers.
   */
  animate(camera: THREE.Camera, cameraMoved: boolean): void {
    if (!cameraMoved) {
      return;
    }
    this.turnAndFace(camera);
  }

  /**
   * THE BILLBOARD TURN. `applyBillboards` writes each billboarded bone's rotation to face the camera,
   * then every one of them is spun 180 degrees about its own Z.
   *
   * **The half-turn is not a fudge: these models' authored front is the far side.** The owner saw the
   * marker "все время задом" -- reliably reversed, never partly so -- which is the signature of a
   * convention mismatch rather than a wrong angle, and it is the third orientation defect on this project
   * to come out that way. Turning the bone is the fix that keeps the billboard pass itself untouched; a
   * negated coordinate would have looked right here and disagreed with every other model in the world.
   */
  private turnAndFace(camera: THREE.Camera): void {
    for (const marker of this.live.values()) {
      const model = marker.model as unknown as {
        billboards?: unknown[]; applyBillboards?: (camera: THREE.Camera) => void;
      };
      if (Array.isArray(model.billboards) && model.billboards.length > 0
        && typeof model.applyBillboards === 'function') {
        model.applyBillboards(camera);
        /**
         * AND TURNED THE OTHER WAY, because this model's authored FRONT is the far side.
         *
         * MEASURED, and the measurement is what picks between two identical-looking causes. The billboard
         * writes `bone.rotation`, which is LOCAL to the bone's parent -- and a marker hangs off a bone of
         * the HOST's skeleton, which already carries the NPC's facing. That would have shown as an error
         * that CHANGES as the NPC turns. The owner walked around one and reported it "всё время задом":
         * constant, independent of the NPC and of where he stood. So the host's rotation is not being
         * inherited, and what remains is the model's own front being on the opposite side from the axis
         * `applySphericalBillboard` points at the camera (its matrix puts `forward` in column 0, i.e. local
         * +X).
         *
         * TWO CONVENTIONS MEETING, which is what every orientation defect in this client has turned out to
         * be -- three for three before this one -- and the fix is at the seam rather than a negated
         * coordinate: the shared billboard code stays exactly as it is, because it is right for every
         * doodad that uses it, and the marker's own bone is turned about the axis the billboard itself
         * calls `up` (column 2 of the same matrix, so local Z).
         */
        for (const bone of model.billboards as Array<{ rotateZ?: (angle: number) => void }>) {
          bone.rotateZ?.(Math.PI);
        }
      }
    }
  }

  private detach(guid: string, marker: Marker): void {
    // Mirrors the adopt, exactly as `releaseAttachedModel` mirrors `adoptAttachedModel`: a registry
    // holding a disposed marker's materials would keep writing light into them for the session.
    this.releaseMaterials?.(marker.model);
    marker.model.parent?.remove(marker.model);
    // A refcount decrement, not a free: several NPCs share one marker path.
    M2Blueprint.unload(marker.model as never);
    this.live.delete(guid);
    this.stats.dropped += 1;
  }

  /** Drop everything, for a worldport or a teardown. */
  dispose(): void {
    for (const [guid, marker] of Array.from(this.live)) {
      this.detach(guid, marker);
    }
    this.live.clear();
    this.loading.clear();
  }
}

export default QuestMarkers;
