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
      }
    }
    this.stats.pending = pending;
  }

  private attach(guid: string, unit: Unit, path: string): void {
    this.loading.add(guid);
    void M2Blueprint.load(path)
      .then((model: THREE.Object3D & { updateMatrix?: () => void }) => {
        this.loading.delete(guid);
        const host = unit.model as unknown as MarkerHost;
        // The unit may have gone, or been re-modelled, while the fetch was out.
        if (host === null || typeof host.attachTo !== 'function' || this.live.has(guid)) {
          M2Blueprint.unload(model as never);
          return;
        }
        if (!host.attachTo(MARKER_ATTACHMENT, model)) {
          // NO SLOT means NO MARKER -- the reference's own behaviour, not a fallback to another bone
          // or to a world-space position. Counted so the instrument can say how often.
          this.stats.noSlot += 1;
          M2Blueprint.unload(model as never);
          return;
        }
        // The marker's own bob, armed looping. Sequence 0; see the header on why 190 is a gap.
        const armable = model as unknown as Armable;
        const seq = armable.modelAnim?.resolve(0);
        if (seq && armable.instanceAnim) {
          armable.instanceAnim.arm(seq as never, worldClock.ms);
        }
        this.live.set(guid, { path, model, baked: false });
        this.stats.attached += 1;
      })
      .catch(() => {
        this.loading.delete(guid);
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
