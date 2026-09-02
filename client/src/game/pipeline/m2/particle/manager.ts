import * as THREE from 'three';

import { ParticleBatch } from './batch';
import { ParticleMaterial } from './material';
import {
  driftPool, followFraction, INHERIT_EMITTER_MOTION,
} from './integrate';
import { ParticlePool } from './pool';
import { RuntimeEmitter } from './runtime-emitter';
import { evaluateAnimationTrack } from './tracks';

interface LiveEmitter {
  emitter: RuntimeEmitter;
  batch: ParticleBatch;
  definition: any;
  instance: any;
  // The bone this emitter hangs off, per M2Particle.boneId, or null when the model has no such bone.
  // Its transform is what orients the emitter; see `basis` on SpawnParams.
  bone: THREE.Bone | null;
  // Scratch for this entry's bone-in-model-space matrix. Per entry rather than shared, because
  // RuntimeEmitter holds a reference to the elements array across frames.
  basis: THREE.Matrix4 | null;
  // Tracks whether this entry was culled as of the previous animate() call, so the pool is only reset
  // on the transition into culled (see I5) rather than every frame it stays culled.
  culled: boolean;
  /**
   * THE EMITTER'S WORLD POSITION LAST FRAME, and whether there was a last frame -- the input to the
   * world-frozen trail (`integrate.ts#driftPool`). Three scalars rather than a `Vector3` because
   * this is read and written on every surviving emitter every frame and never needs vector maths.
   *
   * `hasPrev` is NOT replaceable by "prev is (0,0,0)": the origin is a legal emitter position, and
   * seeding from it would make the first frame of an emitter near 0,0,0 subtract its entire world
   * position from every live particle. It is also reset on the culled transition below, because an
   * emitter that walked 400 units while culled must not apply that whole jump as one frame's drift.
   */
  prevX: number;
  prevY: number;
  prevZ: number;
  hasPrev: boolean;
  /**
   * The `INHERIT_EMITTER_MOTION` accumulator: seconds since the last ~30 Hz trigger. The reference
   * samples the inherit vector at that rate rather than per frame, so a 144 Hz client and a 30 Hz
   * one feed their births the same impulse instead of one seeing 5x finer deltas.
   */
  inheritAccum: number;
}

// Reused across animate() calls to avoid an allocation per emitter per frame.
const scratchWorldPosition = new THREE.Vector3();
const scratchInverse = new THREE.Matrix4();
const scratchDriftBasis = new THREE.Matrix3();
const scratchDrift = new THREE.Vector3();

/**
 * THE WORLD-FROZEN TRAIL'S A/B SWITCH: `window.particleTrailControl.enabled = false` restores the
 * previous behaviour, where every live particle is re-placed relative to the emitter's current
 * position each frame and a travelling emitter's cloud rides it with no history.
 *
 * A switch rather than a constant because this changes EVERY moving emitter in the world, not only a
 * spell missile -- a carried torch, a creature with a particle effect, anything that walks -- and the
 * owner needs to be able to compare the two in one session rather than across a rebuild. Read once
 * per `animate`, never per emitter.
 */
export const particleTrailControl = { enabled: true };

/** The reference's ~30 Hz inherit sampling window, in seconds (`particles.rs:485-492`). */
const INHERIT_INTERVAL = 1 / 30;

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).particleTrailControl = particleTrailControl;
}

/**
 * Owns every live particle emitter and its batch.
 *
 * One emitter gets one pool and one batch. That is deliberate for this phase: RuntimeEmitter integrates
 * its whole pool and reports its whole pool's live count, which is only correct while it owns that pool
 * exclusively. The spec's global 20 000-particle budget with proximity ranking needs a shared pool with
 * per-slot ownership and is Phase 2c.
 */
export class ParticleManager {

  /**
   * Ceiling on one emitter's pool. Capacity is normally derived from the emitter's own rate and
   * lifespan; this only bounds a pathological definition, which does exist in game data.
   */
  static MAX_PARTICLES_PER_EMITTER = 512;

  /**
   * World units beyond which an emitter is culled: not stepped, not packed, and drawn with zero
   * instances. Roughly the distance at which a particle a metre across stops being legible. A
   * proximity-ranked global budget with distance-based culling is Phase 2c; this is a cheap interim
   * cutoff to keep every emitter in the loaded world from simulating and drawing every frame.
   */
  static CULL_DISTANCE = 120;

  private group: THREE.Object3D;
  private emitters: LiveEmitter[] = [];
  private registered = new Set<any>();

  /**
   * The zone's light source, for the fog ramp. Set by the map once it exists. Particles are unlit --
   * the reference's particle shader takes no diffuse or ambient term -- but they are fogged, and a
   * flame that ignores fog stays at full brightness after the geometry behind it has faded out.
   */
  mapLight: any = null;

  constructor(group: THREE.Object3D) {
    this.group = group;
  }

  get emitterCount() {
    return this.emitters.length;
  }

  get liveParticleCount() {
    let total = 0;
    for (const entry of this.emitters) {
      total += entry.emitter.liveCount;
    }
    return total;
  }

  /**
   * Register every particle emitter on a loaded M2 instance.
   *
   * @returns how many emitters were registered
   */
  /**
   * Per-instance texture readiness, for [`ready`]. A `WeakMap` so an instance that is dropped without
   * `unregister` (a disposed effect, a worldported doodad) cannot keep its entry alive.
   */
  private readiness = new WeakMap<object, Promise<void>>();

  /** Returned by `ready` when there is nothing to wait for, so the common case allocates nothing. */
  private static readonly SETTLED: Promise<void> = Promise.resolve();

  /**
   * THE READINESS HANDLE for one registered instance -- resolves when every emitter's texture load has
   * SETTLED. Never rejects; see `ParticleMaterial#ready` for why that is required and not a shortcut.
   *
   * ## Why this exists
   *
   * `register` is synchronous and answers a `number`, but `ParticleMaterial`'s constructor starts a
   * texture load. A caller that registers from inside a `.then` handler therefore creates a promise it
   * has no way to return, and Bluebird reports exactly that -- the warning the owner has now pasted
   * three times. Every such caller can now `return manager.ready(model)` and the chain is JOINED
   * rather than orphaned. Nothing is silenced: the promise is returned, which is what the warning asks
   * for.
   *
   * ## It does NOT gate emission, deliberately
   *
   * The emitter is live from the moment `register` returns and its first frames draw with
   * `TextureLoader.PLACEHOLDER`, exactly as before this handle existed. Holding the emitter back until
   * the texture landed was the alternative and it is the wrong trade for both kinds of caller: a spell
   * effect is a transient burst, so a cast's flash would arrive after the cast that caused it, and a
   * doodad is scenery that would pop in late at zone load. So this answers "has the texture settled"
   * for a caller that wants to chain on it, and changes nothing about what is drawn or when.
   *
   * An instance that was never registered gets the shared resolved promise, so the miss allocates
   * nothing.
   *
   * ## The zone-load cost, measured
   *
   * The two doodad lanes register at zone-load scale, so the added cost was measured rather than
   * argued (`__tests__/manager.test.ts`, median of 7 after 2 warm-ups, 1000 instances per arm):
   *
   *     register x1000, 1 emitter each,  NO ready      53.941 ms  (spread  11.600)
   *     register x1000, 1 emitter each,  with ready    45.934 ms  (spread  15.557)
   *     register x1000, 4 emitters each, NO ready     171.589 ms  (spread  41.621)
   *     register x1000, 4 emitters each, with ready   166.236 ms  (spread 122.734)
   *
   * **Both arms measured the `ready` version as FASTER than the control**, which is impossible as a
   * real effect -- so the honest reading is that the cost is below this instrument's resolution, in
   * both the allocating shape (4 emitters, where a `Promise.all` is built) and the non-allocating one
   * (1 emitter, where the material's own promise is handed straight back). The spreads dwarf the
   * differences. What dominates is `register` itself -- material, batch and pool construction at
   * roughly 46-54 microseconds per single-emitter instance -- and that is untouched.
   */
  ready(instance: any): Promise<void> {
    if (!instance) {
      return ParticleManager.SETTLED;
    }
    return this.readiness.get(instance) ?? ParticleManager.SETTLED;
  }

  register(instance: any): number {
    if (!instance || this.registered.has(instance)) {
      return 0;
    }

    const definitions = instance.particleEmitters || [];
    if (definitions.length === 0) {
      return 0;
    }

    // Built locally first so a throw partway through leaves this.emitters, this.group and
    // this.registered untouched -- a malformed definition must not half-register the instance and
    // permanently wedge it behind the registered.has() guard above.
    const built: LiveEmitter[] = [];

    try {
      for (const definition of definitions) {
        const texture = (instance.textures || [])[definition.textureId];
        const texturePath = texture && texture.filename ? texture.filename : '';

        if (!texturePath) {
          // An emitter with no resolvable texture can never draw, so building a batch for it is
          // pure cost -- it would only ever load the empty placeholder path.
          const path = instance && instance.path ? instance.path : instance;
          // eslint-disable-next-line no-console
          console.warn('ParticleManager: skipping emitter with unresolvable textureId', definition.textureId, 'for', path);
          continue;
        }

        const capacity = ParticleManager.capacityFor(definition);

        const material = new ParticleMaterial(texturePath, definition.blendingType);
        const batch = new ParticleBatch(material, capacity, definition.rows, definition.columns);
        const pool = new ParticlePool(capacity);

        // M2Particle.boneId names the bone whose transform orients this emitter. A model may have no
        // bones at all, or name one out of range in malformed data, so an unresolved bone falls back
        // to null -- meaning "emit along model space", the pre-bone-binding behaviour.
        const bones = instance.bones;
        const bone = (bones && bones[definition.boneId]) || null;

        built.push({
          emitter: new RuntimeEmitter(definition, pool),
          batch, definition, instance,
          bone,
          basis: bone ? new THREE.Matrix4() : null,
          culled: false,
          // `hasPrev` false so the FIRST frame establishes the anchor and drifts nothing -- see the
          // field's own doc for why (0,0,0) is not a usable sentinel.
          prevX: 0, prevY: 0, prevZ: 0, hasPrev: false, inheritAccum: 0,
        });
      }
    } catch (error) {
      for (const entry of built) {
        entry.batch.geometry.dispose();
        (entry.batch.material as THREE.Material).dispose();
      }

      const path = instance && instance.path ? instance.path : instance;
      // eslint-disable-next-line no-console
      console.error('ParticleManager: failed to register emitters for', path, error);

      return 0;
    }

    this.registered.add(instance);

    for (const entry of built) {
      this.group.add(entry.batch);
      this.emitters.push(entry);
    }

    // The readiness handle, recorded only when there is something to wait for. `Promise.all` over the
    // materials' own chains -- see `ready` for what it is for and why it does not gate emission.
    if (built.length > 0) {
      const settled = built.map((entry) => (entry.batch.material as ParticleMaterial).ready);
      this.readiness.set(
        instance,
        settled.length === 1 ? settled[0] : Promise.all(settled).then(() => undefined),
      );
    }

    return built.length;
  }

  unregister(instance: any) {
    if (!this.registered.has(instance)) {
      return;
    }

    this.registered.delete(instance);
    this.readiness.delete(instance);

    this.emitters = this.emitters.filter((entry) => {
      if (entry.instance !== instance) {
        return true;
      }

      this.group.remove(entry.batch);
      entry.batch.geometry.dispose();
      (entry.batch.material as THREE.Material).dispose();

      return false;
    });
  }

  animate(delta: number, camera: THREE.Camera) {
    const cullDistanceSquared = ParticleManager.CULL_DISTANCE * ParticleManager.CULL_DISTANCE;

    // Clamp at the manager boundary: after a backgrounded tab, `Clock.getDelta()` can hand back several
    // seconds' worth of elapsed time in one call. A multi-second Euler step would teleport every live
    // particle across the screen for a frame before the lifespan check kills them. 0.1s (~6 frames at
    // 60fps) is generous for a normal frame and still short enough that a resumed tab doesn't visibly
    // jump.
    const dt = Math.min(delta, 0.1);
    // ONCE per animate, never per emitter -- the same rule `blendControl` follows in `instance-anim`.
    const trailEnabled = particleTrailControl.enabled;

    for (const entry of this.emitters) {
      // Read matrixWorld directly instead of calling updateMatrixWorld() up front: the renderer's own
      // scene.updateMatrixWorld() has already produced it this frame, and a static doodad's subtree
      // (submeshes plus bone hierarchy) doesn't need walking again just to answer the cull distance
      // check. Recursing that subtree is only worth paying for emitters that survive the cull below.
      scratchWorldPosition.setFromMatrixPosition(entry.instance.matrixWorld);
      const distanceSquared = camera.position.distanceToSquared(scratchWorldPosition);

      if (distanceSquared > cullDistanceSquared) {
        // Beyond the cull distance: don't step or pack, and draw nothing. Comparing squared
        // distances avoids a per-emitter, per-frame Math.sqrt.
        if (!entry.culled) {
          // Release on the transition into culled, not every frame: an emitter simulates nothing while
          // culled, so re-resetting an already-empty pool every frame would be pure waste. Without this,
          // particles freeze mid-animation instead of being released, so walking away and back shows a
          // stale, frozen puff before the emitter resumes -- and the pool's slots are never reclaimed.
          entry.emitter.pool.reset();
          entry.culled = true;
          // See `hasPrev`: an emitter that travelled while culled must not hand its whole
          // displacement to the first uncelled frame as one step of drift.
          entry.hasPrev = false;
          entry.inheritAccum = 0;
        }

        (entry.batch.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
        entry.batch.visible = false;
        continue;
      }

      entry.culled = false;
      entry.batch.visible = true;

      // Only for emitters that survived the cull: copying onto all 698 materials every frame would
      // be almost entirely wasted, since fewer than 60 are usually drawing.
      if (this.mapLight) {
        const uniforms = (entry.batch.material as THREE.ShaderMaterial).uniforms;
        if (uniforms && uniforms.fogParams) {
          uniforms.fogParams.value.copy(this.mapLight.uniforms.fogParams.value);
          uniforms.fogColor.value.copy(this.mapLight.uniforms.fogColor.value);
          uniforms.wmoFogParams.value.copy(this.mapLight.uniforms.wmoFogParams.value);
          uniforms.wmoFogColor.value.copy(this.mapLight.uniforms.wmoFogColor.value);
          // The owning instance's own interior-fog flag (per-object-light.ts) -- an emitter hanging
          // off a doodad standing in a WMO interior fogs with the room's haze too. Instances that
          // never went through WMO#foldDoodadLighting (an ADT-placed M2, say) have no
          // `perObjectLighting` at all, so this defaults to the scene triple, same as before.
          uniforms.interiorFog.value = entry.instance.perObjectLighting && entry.instance.perObjectLighting.interiorFog ? 1.0 : 0.0;
        }
      }

      // The instance's own matrix places its particles in the world; the emitter's bone orients them
      // within the model. This also refreshes the bone subtree, which the basis below reads.
      entry.instance.updateMatrixWorld(false);

      // THE WORLD-FROZEN TRAIL. `pack()` re-places every live particle through the emitter's CURRENT
      // world matrix, so the store is anchor-riding and a travelling emitter's cloud rides it with no
      // history -- correct for a campfire, and what destroys a spell missile's tail. Leaving the
      // emitter's own per-frame motion behind is the reference's `(fraction - 1) * delta` move for an
      // anchor-riding store; see `integrate.ts#driftPool` for the citation and for why the polarity
      // is settled by the original client rather than by the reference, which contradicts itself.
      //
      // ORDER: after `updateMatrixWorld` so the position is this frame's, and BEFORE `step()` so the
      // particles born this frame are not drifted by a motion that happened before they existed.
      const we = entry.instance.matrixWorld.elements;
      const wx = we[12];
      const wy = we[13];
      const wz = we[14];
      const emitterFlags = entry.definition.flags | 0;
      // TWO INDEPENDENT AXES, and `integrate.ts#INHERIT_EMITTER_MOTION` says why they are not in
      // conflict: the world-frozen drift lags the whole live cloud every frame, `0x40` gives each
      // BIRTH a forward impulse.
      //
      // NO FLAG GATE ON THE DRIFT, and `integrate.ts#FOLLOW_EMITTER` carries the whole reasoning and
      // the polarity's history. The short version: world-frozen is the BASELINE and `0x4000` is what
      // buys a ride back, via `followFraction`'s line -- so every moving emitter drifts unless its
      // own data says otherwise, and `followFraction` returning 0 for an unflagged emitter is what
      // makes `leave` 1. A static emitter still reaches nothing: its delta is exactly zero.
      const lags = trailEnabled;
      const inherits = (emitterFlags & INHERIT_EMITTER_MOTION) !== 0;
      if (inherits) {
        entry.inheritAccum += dt;
      }
      if ((lags || inherits) && entry.hasPrev) {
        const ddx = wx - entry.prevX;
        const ddy = wy - entry.prevY;
        const ddz = wz - entry.prevZ;
        // THE EARLY-OUT THAT KEEPS EVERY CAMPFIRE FREE. A static emitter's delta is exactly zero, so
        // it pays this three-way compare and nothing else -- no inverse, no Matrix3, no pool walk.
        if (ddx !== 0 || ddy !== 0 || ddz !== 0) {
          // ONE rotation into the POOL's local frame, shared by both flags -- that is the space the
          // pool stores, the space `integratePool` applies gravity in, and the space
          // `spawnParticle` has already rotated the emission velocity into by the time the inherit
          // is added. A Matrix3 and `applyMatrix3` rather than `transformDirection`, which
          // NORMALISES -- it would make both effects independent of the emitter's actual speed.
          scratchDriftBasis.setFromMatrix4(scratchInverse.copy(entry.instance.matrixWorld).invert());
          scratchDrift.set(ddx, ddy, ddz).applyMatrix3(scratchDriftBasis);

          if (lags) {
            const keep = followFraction(
              entry.definition,
              dt > 0 ? Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) / dt : 0,
            );
            const leave = 1 - keep;
            if (leave > 0) {
              driftPool(
                entry.emitter.pool,
                scratchDrift.x * leave, scratchDrift.y * leave, scratchDrift.z * leave,
              );
            }
          }

          // THE ~30 Hz TRIGGER. `delta / accum` is the emitter's velocity over the window that just
          // closed; `inheritVelocityScale` is the file's own multiplier on it (`inherit_scale`,
          // reference `particles.rs:405-409`). The 1/30 in the reference's expression is a storage
          // convention and cancels here -- see `INHERIT_EMITTER_MOTION`.
          if (inherits && entry.inheritAccum >= INHERIT_INTERVAL) {
            const scale = (Number(entry.definition.inheritVelocityScale) || 0)
              / entry.inheritAccum;
            entry.emitter.setInheritVelocity(
              scratchDrift.x * scale, scratchDrift.y * scale, scratchDrift.z * scale,
            );
            entry.inheritAccum = 0;
          }
        }
      }
      // "ZEROED WHILE NO PARTICLES ARE LIVE" is the reference's own clause, and it is what stops a
      // long-dormant emitter handing a stale impulse to its first birth after it wakes.
      if (inherits && entry.emitter.pool.liveCount === 0) {
        entry.emitter.setInheritVelocity(0, 0, 0);
      }
      entry.prevX = wx;
      entry.prevY = wy;
      entry.prevZ = wz;
      entry.hasPrev = true;

      // Bone-in-model-space = inverse(model world) * bone world. `pack()` then applies the model's
      // world matrix to every particle, so composing the two puts a spawn exactly where its bone is
      // while keeping the pool in model space. Recomputed each frame so an animated bone drags its
      // emitter along; for a static doodad like a portal it simply resolves to the same matrix.
      if (entry.bone && entry.basis) {
        scratchInverse.copy(entry.instance.matrixWorld).invert();
        entry.basis.multiplyMatrices(scratchInverse, entry.bone.matrixWorld);
        entry.emitter.setBasis(entry.basis.elements);
      }

      // advance() is a self-driven stand-in for the model's animation mixer, wrapped to the longest
      // timestamp among the emitter's own animated inputs. Driving this from the mixer's real time,
      // wrapped to the clip duration, is Phase 2c.
      entry.emitter.step(dt, entry.emitter.advance(dt));
      // `particleSizeScale` is an optional per-instance knob -- see `ParticleBatch#pack`. Absent on
      // every model but the ones that ask for it, so this is one property read.
      entry.batch.pack(
        entry.emitter.pool, entry.definition, entry.instance.matrixWorld,
        entry.instance.particleSizeScale ?? 1,
      );
    }
  }

  /**
   * The largest value anywhere in an animated track, over every animation it carries.
   *
   * `capacityFor` needs the PEAK rather than a sample, and the difference is not academic -- see its
   * own comment. Falls back to `fallback` for a track with no data, exactly as
   * `evaluateAnimationTrack` does, so a definition with no track behaves as before.
   */
  private static trackPeak(block: any, fallback: number): number {
    const tracks = block && block.tracks;
    if (!tracks || tracks.length === 0) {
      return fallback;
    }
    let peak = -Infinity;
    for (const track of tracks) {
      const values = track && track.values;
      if (!values) {
        continue;
      }
      for (let i = 0; i < values.length; ++i) {
        if (typeof values[i] === 'number' && values[i] > peak) {
          peak = values[i];
        }
      }
    }
    return peak === -Infinity ? fallback : peak;
  }

  /**
   * How many particle slots to allocate for one emitter, decided ONCE at register time.
   *
   * ## THE PEAK, NOT THE VALUE AT t=0, AND THAT IS A MEASURED FIX
   *
   * This used to sample `emissionRate` and `lifespan` at `timeMs = 0`. For a DOODAD that is correct --
   * a fountain or a brazier emits at a constant rate, so its t=0 sample IS its rate. For a SPELL
   * EFFECT it is wrong in a way that shows as "the effect has no particles at all": a spell emitter
   * RAMPS, so its authored rate at t=0 is frequently 0, the pool was then built with the floor of one
   * slot, and the emitter could never hold more than a single particle however hard it emitted later.
   *
   * Measured on the real served models (`game/world/__bench__/effect-emitter-probe.test.ts`), where
   * `rate(t=0)` is what this function used to read and `rateMax` is what it reads now:
   *
   *     Spells\DustCloud_Land.mdx      1 emitter   rate(t=0) 0.0  rateMax  50.0  ->  1 slot, now  51
   *     Spells\ChargeTrail.mdx         1 emitter   rate(t=0) 0.0  rateMax  10.0  ->  1 slot, now  11
   *     Spells\Frost_Nova_state.mdx    9 emitters  5 of them at rate(t=0) 0.0, rateMax 50-450
   *     Spells\Fireball_Missile_Low.mdx 4 emitters  rate(t=0) == rateMax on all four -- unaffected
   *
   * **6 of the 25 emitters measured across six real effect models were starved to a single slot**, and
   * both of Warrior Charge's two emitters were among them -- which is the owner's "партиклов нет" on
   * that spell, exactly. The models whose rate is already flat, including every doodad emitter this
   * function has ever sized, get the identical number they got before.
   *
   * The cost of the change is memory, and it is bounded by the same `MAX_PARTICLES_PER_EMITTER` clamp
   * as before (512): the worst row measured, Frost Nova's 450/sec over a 0.5 s lifespan, asks for 226
   * slots against the 1 it used to get. A slot is a handful of floats in the pool's typed arrays, so
   * this is kilobytes per emitter and only for emitters that actually exist.
   */
  private static capacityFor(definition: any): number {
    const rate = ParticleManager.trackPeak(definition.emissionRate, 0);
    const lifespan = ParticleManager.trackPeak(
      definition.lifespan, RuntimeEmitter.DEFAULT_LIFESPAN_SECONDS,
    );

    // +1 covers the fractional accumulator's overshoot; the floor of 1 keeps a zero-rate emitter from
    // constructing zero-length typed arrays.
    const needed = Math.ceil(Math.max(0, rate) * Math.max(0, lifespan)) + 1;

    return Math.max(1, Math.min(ParticleManager.MAX_PARTICLES_PER_EMITTER, needed));
  }

}
