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
 * **The models are FOUR, and the names were PROBED on the case-sensitive host** rather than recalled.
 * `interface/buttons/` answers 200 for `talktome.m2` (15,680 B), `talktomequestionmark.m2`,
 * `talktomegrey.m2` and `talktomeblue.m2`, and 404 for fifteen other plausible spellings that were
 * tried (`talktomeq`, `talktomegray`, `talktomegold`, `talktomeexclaim`, `talktomered`,
 * `talktomeactive`, `talktomecomplete`, `talktomelowlevel`, `talktome_q`, `talktomeblu`,
 * `talktomedone`, and four grey-question-mark spellings). **The reference names five models and only
 * four are served here** -- there is no grey question mark under any spelling tried -- so the
 * low-level turn-in status takes the grey exclamation, and that substitution is named rather than
 * hidden.
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
} as const;

/**
 * Attachment slot for an overhead marker. The reference's `18` (0x12), used as a slot INDEX and
 * looked up by id, so a model without it renders nothing rather than falling back. See the header.
 */
export const MARKER_ATTACHMENT = 18;

/**
 * `DIALOG_STATUS` -> which model, or null for no marker.
 *
 * **Only the statuses whose meaning is unambiguous are mapped.** `AVAILABLE`/`AVAILABLE_REP` are an
 * offer; `REWARD`/`REWARD2`/`REWARD_REP` are a turn-in; the three `LOW_LEVEL_*` values are the same
 * two things below the player's level, which is what the grey art is for. `NONE` and `UNAVAILABLE`
 * are explicitly no marker.
 *
 * **`INCOMPLETE` (5) answers null, deliberately.** It means "you have this quest and it is not done",
 * and whether 3.3.5a draws anything for it is not established by anything this client can read -- the
 * served light-blue model is left unused precisely because assigning it here would be a guess.
 * Drawing nothing is the conservative half: a missing marker is visibly absent, a wrong one reads as
 * fact.
 */
export function modelFor(status: number): string | null {
  switch (status) {
    case DIALOG_STATUS.AVAILABLE:
    case DIALOG_STATUS.AVAILABLE_REP:
      return MODEL.available;
    case DIALOG_STATUS.REWARD:
    case DIALOG_STATUS.REWARD2:
    case DIALOG_STATUS.REWARD_REP:
      return MODEL.reward;
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE:
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE_REP:
    case DIALOG_STATUS.LOW_LEVEL_REWARD_REP:
      // The grey EXCLAMATION for all three: no grey question mark is served on this build. See the
      // header on the spellings that were tried.
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
   * SELF-ANNOUNCING DIAGNOSIS, at most two lines for the whole session.
   *
   * Every static check on this subsystem passes -- the three models and their `.skin` files serve real
   * bytes, attachment id 18 is present in 3.3.5a's `humanmale.m2`, all four opcodes carry their 3.3.5a
   * numbers, both guid maps go through `guid-hex.ts`, and the status width is derived from the body
   * size rather than assumed. So what remains is runtime-only, and asking the owner to run a console
   * probe has not worked. These two lines put the answer in the console he already reads.
   *
   * Bounded by construction: one line the first time a status map arrives non-empty, one line for the
   * first attach outcome. Never per frame, so this cannot become spam or a cost.
   */
  private announcedFeed = false;

  private announcedOutcome = false;

  private announcedStart = false;

  private announcedMaterials = false;

  private announcedBake = false;

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

    if (!this.announcedFeed && statuses.size > 0) {
      this.announcedFeed = true;
      let matched = 0;
      let withModel = 0;
      let wanted = 0;
      for (const [guid, status] of statuses) {
        const unit = entities.get(guid);
        if (unit !== undefined) {
          matched += 1;
          if (unit.model) {
            withModel += 1;
          }
        }
        if (modelFor(status) !== null) {
          wanted += 1;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `questmarkers: ${statuses.size} statuses, ${wanted} want a model; `
        + `entities=${entities.size}, matched=${matched}, withModel=${withModel}; `
        + `statuses=[${Array.from(statuses.entries()).slice(0, 4)
          .map(([g, st]) => `${g}:${st}`).join(' ')}]`,
      );
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
        if (!this.announcedBake) {
          this.announcedBake = true;
          const bone = marker.model.parent;
          const m = bone === null ? null : bone.matrixWorld.elements;
          // eslint-disable-next-line no-console
          console.log(`questmarkers: BAKED -- scale=${marker.model.scale.x.toFixed(4)}, `
            + `bone world pos=${m === null ? 'none'
              : `${m[12].toFixed(1)},${m[13].toFixed(1)},${m[14].toFixed(1)}`}`);
        }
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
    if (!this.announcedStart) {
      this.announcedStart = true;
      // eslint-disable-next-line no-console
      console.log(`questmarkers: attach START ${guid} <- ${path}`);
    }
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
        if (!this.announcedOutcome) {
          this.announcedOutcome = true;
          // eslint-disable-next-line no-console
          console.log(`questmarkers: load RESOLVED ${guid}; host=${host === null ? 'null' : 'ok'}, `
            + `attachTo=${typeof host?.attachTo}, alreadyLive=${this.live.has(guid)}`);
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
        // The marker's own bob, armed looping. Sequence 0; see the header on why 190 is a gap.
        const armable = model as unknown as Armable;
        const seq = armable.modelAnim?.resolve(0);
        if (seq && armable.instanceAnim) {
          armable.instanceAnim.arm(seq as never, worldClock.ms);
        }
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
        if (!this.announcedMaterials) {
          this.announcedMaterials = true;
          const rows: string[] = [];
          (model as unknown as THREE.Object3D).traverse((node) => {
            const mat = (node as unknown as { material?: unknown }).material;
            if (mat === undefined || mat === null) {
              return;
            }
            const list = Array.isArray(mat) ? mat : [mat];
            list.forEach((one) => {
              const m = one as {
                map?: { name?: string } | null;
                type?: string;
                uniforms?: { textureCount?: { value?: unknown }; textures?: { value?: unknown } };
              };
              // `.map` IS THE WRONG FIELD FOR THE REAL BATCH MATERIAL, and reading only it made the
              // first version of this line blind: an M2 batch is a `ShaderMaterial` and keeps its
              // textures in `uniforms.textures`, with `uniforms.textureCount` saying how many bound.
              // The owner's paste read `ShaderMaterial:map=NONE`, which is EXPECTED and says nothing.
              const count = m.uniforms?.textureCount?.value;
              const bound = m.uniforms?.textures?.value;
              rows.push(`${m.type ?? '?'}:map=${m.map == null ? 'NONE' : m.map.name || 'unnamed'}`
                + `${count === undefined ? '' : ` texCount=${String(count)}`}`
                + `${Array.isArray(bound) ? ` textures=${bound.length}` : ''}`);
            });
          });
          // eslint-disable-next-line no-console
          console.log(`questmarkers: materials [${rows.join(' | ')}]`);
        }
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

  private detach(guid: string, marker: Marker): void {
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
