import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';

/**
 * THE LEVEL-UP EFFECT -- the golden burst on the character, and the owner's "хотел бы чтобы lvl up был
 * анимированным".
 *
 * ## IT IS THE GAME'S OWN MODEL AND THE GAME'S OWN DATA NAMES IT
 *
 * `SpellVisualEffectName.dbc` **row 21** is named literally `HARDCODED Unit Level Up` and its model
 * column is `Spells\LevelUp\LevelUp.mdl`. "HARDCODED" is the game's own label for an effect the engine
 * plays itself rather than through a spell -- the neighbouring rows use it the same way for the loot
 * sparkle (row 14, `HARDCODED Loot Art`) and the mount poof (row 1185, `HARDCODED Mount Poof`). So
 * there is no spell to cast and no `SpellVisualKit` to walk: the client plays this model on the unit
 * when its level changes, and the DBC row exists to give the artists a handle on it.
 *
 * The served host answers `spells/levelup/levelup.m2` **200 / 18,256 bytes** with
 * `spells/levelup/levelup00.skin` **200 / 1,248 bytes**, so the model is fetchable at the same path the
 * DBC names with `.mdl` swapped for `.m2` -- the same rename every other model reference in this client
 * goes through.
 *
 * **NOTHING HERE IS INVENTED.** The round was told not to invent an effect, and the three things the
 * 3.3.5a client actually does on a level-up are: this model, `sound/interface/levelup.wav`, and the
 * chat lines `chatframe.lua:2562-2601` prints from `PLAYER_LEVEL_UP`. There is no level-up FRAME in
 * 3.3.5a -- `LevelUpDisplay` is Cataclysm's, and grepping the whole 3.3.5a manifest for
 * `PLAYER_LEVEL_UP` finds exactly two consumers, `chatframe.lua` and `MainMenuBar.lua:304` (the XP
 * bar). The sound is the one part not built: this client has no audio engine at all
 * (`framexml/lua/api/sound.ts` -- every `PlaySound` is a no-op), so playing it would mean starting a
 * mixer, which is a subsystem and not a line. Stated rather than skipped silently.
 *
 * ## THE FRAME BUDGET
 *
 * Zero when idle, by construction rather than by measurement: `update` returns on
 * `this.live.length === 0`, so a frame with no level-up in flight pays one array-length compare. That
 * is the same shape as the existing world-visual guards and it is why this is a separate module with
 * its own tick rather than a branch inside the unit loop.
 *
 * It costs the UI draw fingerprint exactly NOTHING, for the reason `selection-ring.ts` states about
 * itself: this is world geometry in the world scene, and `drawListSignature` mixes UI draw items and
 * cannot see it. So the offscreen-target saving `world-ui.ts` exists for is untouched.
 *
 * While one IS live the cost is one `updateMatrixWorld` on a single node plus whatever its own
 * emitters cost in `ParticleManager#animate` -- which is the manager's existing per-emitter cost and
 * not new work. **The emitter count and the particle count of this model have not been measured**,
 * because that needs the model parsed in a browser and this round had no world to enter; the number is
 * owed and named as owed rather than estimated.
 */
export class LevelUpEffect {
  private scene: THREE.Scene;

  /**
   * `map.particleManager`, or null before a map exists. The effect is a particle model, so without
   * registration it would draw nothing at all -- which is why `play` takes it rather than caching it:
   * the map is replaced on a worldport and a cached manager would be the previous world's.
   */
  private live: Array<{
    model: THREE.Object3D & { updateMatrix?: () => void };
    manager: { unregister: (instance: unknown) => void } | null;
    /** Milliseconds left before the model is unloaded. */
    remaining: number;
  }> = [];

  /**
   * How long a played effect is kept.
   *
   * **UNEXPLAINED, and said so rather than sourced.** The model's own sequence length is authored in
   * its M2 header and this client does not read a duration out of a free-standing effect model -- the
   * unit path takes its lengths from `M2#instanceAnim`, which a particle-only model may not allocate.
   * 2.5 s is long enough for a burst of this kind to finish emitting and short enough that a fast
   * sequence of levels cannot stack more than two or three. Replace it with the model's real sequence
   * length the day a duration is readable here.
   */
  static DURATION_MS = 2500;

  /** `Spells\LevelUp\LevelUp.mdl` with the standard `.m2` rename. See the header. */
  static MODEL = 'spells\\levelup\\levelup.m2';

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Play the effect at a world position.
   *
   * The load is async and the position is captured NOW rather than read when it resolves: a level-up
   * lands while the character is usually standing still, and sampling the player again after a fetch
   * would put the burst wherever he had walked to. If the model is still loading when a second level
   * arrives, both play -- which is the honest behaviour for two levels in a row.
   */
  play(
    position: THREE.Vector3,
    particleManager: { register: (instance: unknown) => number;
      unregister: (instance: unknown) => void; } | null,
  ): void {
    const at = position.clone();
    void M2Blueprint.load(LevelUpEffect.MODEL)
      .then((model: THREE.Object3D & { updateMatrix?: () => void }) => {
        model.position.copy(at);
        // `M2` sets `matrixAutoUpdate = false` on itself (`pipeline/m2/index.ts`), and the whole scene
        // has `matrixWorldAutoUpdate = false` -- so a model added without these two calls has an
        // identity matrix and draws at the world origin. That is the trap `unit.ts#applyRenderScale`
        // records for `scale.setScalar`, in its other half.
        if (typeof model.updateMatrix === 'function') {
          model.updateMatrix();
        }
        this.scene.add(model);
        model.updateMatrixWorld(true);
        if (particleManager !== null) {
          particleManager.register(model);
        }
        this.live.push({ model, manager: particleManager, remaining: LevelUpEffect.DURATION_MS });
      })
      .catch(() => {
        // `M2Blueprint.load` logs its own failure. A missing effect model is a missing burst, not a
        // broken level-up: the chat lines and the XP bar come from the client's own Lua either way.
      });
  }

  /** One frame. Returns immediately with nothing live -- see the header on the idle cost. */
  update(deltaMs: number): void {
    if (this.live.length === 0) {
      return;
    }
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const entry = this.live[i];
      entry.remaining -= deltaMs;
      if (entry.remaining > 0) {
        continue;
      }
      entry.manager?.unregister(entry.model);
      this.scene.remove(entry.model);
      // A refcount decrement, not a free: another effect of the same path may still be live. Same
      // discipline as `unit.ts#release`.
      M2Blueprint.unload(entry.model as never);
      this.live.splice(i, 1);
    }
  }

  /** Drop everything, for a worldport or a teardown. */
  dispose(): void {
    for (const entry of this.live) {
      entry.manager?.unregister(entry.model);
      this.scene.remove(entry.model);
      M2Blueprint.unload(entry.model as never);
    }
    this.live = [];
  }
}

export default LevelUpEffect;
