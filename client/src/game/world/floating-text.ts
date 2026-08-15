/**
 * FLOATING COMBAT TEXT: the big number -- or the word "Dodge" -- that rises off the unit you just hit.
 *
 * One of the two media the owner asked for ("По цифрам оба варианта" -- both variants). This is the
 * **engine-drawn** one; the other is the client's own `CombatFeedback` on the player's portrait, driven
 * from `ui/unit-bridge.ts` through `UNIT_COMBAT`. The decision about WHAT the text says is shared
 * between them and lives in `classes/combat-text.ts`, so the two can never disagree.
 *
 * ## Which medium, and why it is not a widget
 *
 * **World-pass geometry, exactly as `world/nameplates.ts` argues at length and for the same three
 * reasons.** In brief, and each is checkable rather than asserted:
 *
 *  1. **The reference.** `samples/benilla/crates/benilla/src/combat_text/` is the whole system, and it
 *     is a world-text batch (`WORLDTEXTSTRING`) with its own config table at `0xce8828`, its own fade
 *     law at `0x6c82e0` and its own emitters at `0x6243e0` -- not a frame, not a region, and it appears
 *     in no manifest file.
 *  2. **`CLAUDE.md`'s rule is not violated.** The rule is that every screen and frame must be the
 *     client's own XML and Lua. A floating number is not a frame in 3.3.5a: no addon can hook one and
 *     `WorldFrame` declares no region for it. Drawing it is the ENGINE side of the division, the side
 *     `drawSweeps`, the selection ring and the nameplates are already on.
 *  3. **The frame budget.** A number that moves every frame would dirty `drawListSignature` every frame
 *     it lived and hand back the 4-7.5 ms the offscreen target saves. World geometry is invisible to
 *     that fingerprint by construction, which the ring's and the plates' measured zero extra dirty
 *     frames already establish.
 *
 * ## What is ported, and what is not
 *
 * PORTED, all from `combat_text/law.rs` and cited at the line: the six-row config table, the fade law
 * (including the store seam that caps the shadow at the text's alpha), the crit pop keyframes, the
 * emitter's branch order, the size law's SCREEN-DIAGONAL basis with its aspect term, and the shadow's
 * per-axis viewport fraction. The bits the emitter reads are **3.3.5a's, not the reference's** -- see
 * `combat-text.ts`' header for why that is the sharp case here.
 *
 * NOT PORTED, each with a reason:
 *
 *  - **The anti-overlap solver** (`claimed_box_px`, `law.rs:238-254`, and the DDC rect solver at
 *    `0x6c7cc0`). Two numbers landing in the same 150 ms therefore overlap instead of being pushed
 *    apart. It is a real difference and it is named rather than approximated, because a hand-rolled
 *    "nudge the second one up" is exactly the invented-substitute this project keeps deleting.
 *  - **The pet legs** of the colour branch (`damage_color`, `law.rs:136-146`, orange pet melee / gold
 *    pet spell). There is no pet feed, so neither pet leg is reachable. The two PLAYER legs both are
 *    now: melee's override is NULL (the row's own white) and spell's is `COLOR_SPELL_GOLD`.
 *    **The spell and periodic emitters were listed here as unported** because they needed
 *    `SMSG_SPELLNONMELEEDAMAGELOG` / `SMSG_PERIODICAURALOG`, "which this client does not decode, so a
 *    spell's damage floats NOTHING". Those packets decode now
 *    (`network/game/object/combat-log.ts`) and `combat-text.ts#spellText` is the emitter, so that
 *    entry is retired rather than left describing a closed gap.
 *  - **`melee_styled`** (`net/apply/combat_log.rs:66-77`), the leg that makes a ranged BASIC shot --
 *    Throw, Auto Shot -- float WHITE off the spell packet rather than gold, off `AttributesEx3 & 0x8000`
 *    or a spell id with no catalog record. `Spell.dbc` column 4's word block is already decoded in this
 *    client (the spellbook filter reads bit `0x80` of it) but `AttributesEx3` is a DIFFERENT word of that
 *    block and is not read, so this is NOT implemented: a hunter's Auto Shot will float gold where the
 *    real client floats it white. Named rather than approximated.
 *  - **Rows 4 and 5** (XP and honor) are in the table because they are part of it; nothing selects them.
 *  - **The per-tick re-raster of a popping crit.** The reference re-renders the glyphs at the new size
 *    every tick; here the string is rasterized ONCE at its settled size and the sprite is SCALED for the
 *    pop, so the 150 ms peak is a 2x upscale of the settled raster. A per-frame re-raster of a canvas is
 *    the cost `nameplates.ts` measures itself against and it buys 150 ms of sharpness.
 */
import * as THREE from 'three';

import type Unit from '../classes/unit';
import {
  CATEGORIES, CATEGORY_CRIT, Category, argbRgb, fadeAlpha, scaleValue, shadowOffsetUnits, sizeUnits,
} from '../classes/combat-text';
import { FontStringTextures } from '../ui/text';
import type { FontSpec } from '../ui/widget';
import { PLATE_RENDER_CEILING, overheadAnchor } from './nameplates';

/**
 * A live text. `unit` is held so the number tracks a walking victim, which the reference does too --
 * the world-text node is parented to the emitting unit's overhead anchor and only the RISE is
 * integrated. Null once the unit is gone, at which point the last anchor is kept.
 */
interface Floater {
  sprite: THREE.Sprite;
  unit: Unit | null;
  /** The anchor to use once `unit` is null -- the last one we saw. */
  lastZ: number;
  lastX: number;
  lastY: number;
  category: Category;
  categoryIndex: number;
  /** ms since the spawn, on the same clock the fade law is written in. */
  ageMs: number;
  /** The sprite's logical size at the SETTLED scale value -- the pop multiplies it. See the header. */
  baseW: number;
  baseH: number;
  /** The settled scale value the raster was built for, so the pop factor is a ratio and not a re-measure. */
  settled: number;
}

/**
 * How many floaters live at once.
 *
 * **OURS**, and it is a draw-call bound rather than a law: nothing in the reference caps the world-text
 * pool (its solver spreads them instead, which is the thing not ported above). A 1.5 s life against the
 * fastest weapon timer is at most two or three per attacker, so 24 covers a real fight with margin and
 * still bounds the pass. The oldest is recycled, which is the honest failure mode -- a dropped number
 * rather than an unbounded scene.
 */
export const MAX_FLOATERS = 24;

/**
 * Where the text starts, relative to the unit's overhead anchor, in yards.
 *
 * **OURS.** The reference spawns at the anchor itself; here the nameplate already occupies that spot,
 * and a number drawn through the plate's brass frame is a number nobody can read. Half a yard clears it
 * at the plate's own 17-texel height for every unit size in Northshire. Stated because it is a choice.
 */
const SPAWN_LIFT = 0.5;

/** How the client's own `CombatFeedbackText` keys are turned into real words. See `WORD_SOURCE`. */
export type WordSource = (key: string) => string | null;

/** What `spawn` is told. Assembled by `World` from `combat-text.ts#meleeText`/`#spellText`. */
export interface FloaterSpawn {
  unit: Unit;
  category: number;
  text: string;
  /**
   * THE EMITTER'S COLOUR OVERRIDE, packed ARGB, or `undefined` for the category row's own colour.
   *
   * The reference's colour branch (`law.rs:136-146`, the client's `0x6128b0`) picks an override per
   * (source, melee) pair rather than per category: a qualifying source's SPELL damage is GOLD
   * `COLOR_SPELL_GOLD`, its MELEE damage has a NULL override and falls through to the row's white. Until
   * the spell packets were decoded only the melee leg was reachable, which is why this field did not
   * exist and the header below recorded the colour branch as unported.
   */
  color?: number;
}

export class FloatingCombatText {
  private readonly group = new THREE.Group();

  private readonly live: Floater[] = [];

  /** Sprites whose life ended, kept for reuse -- a sprite plus a material is not free to build. */
  private readonly pool: THREE.Sprite[] = [];

  private readonly fonts = new FontStringTextures();

  /** `window.combatText()` -- the pass's own numbers. */
  readonly stats = {
    live: 0,
    spawned: 0,
    /**
     * `FontStringTextures.get` CALLS -- not rasterizations.
     *
     * **SELF-REVIEW CORRECTED THIS FIELD AND ITS NAME.** It was called `rasterized` and described as
     * "one per DISTINCT string, the cache dedupes", while the code incremented it once per spawn. The
     * live run reported `spawned: 8, rasterized: 8`, which is exactly what an instrument that is really
     * a second copy of `spawned` looks like -- the "debug panel that reads zero while the world is fine"
     * failure, in its other direction. The cache behind this call genuinely does dedupe ("37" twice is
     * one canvas), but this counter has never been able to observe that and does not claim to now.
     */
    fontLookups: 0,
    dropped: 0,
    updateMs: 0,
  };

  constructor(scene: THREE.Scene) {
    this.group.name = 'FloatingCombatText';
    // The world scene, so `drawListSignature` cannot see it -- the whole efficiency argument, and the
    // same line `nameplates.ts` carries.
    scene.add(this.group);
  }

  /**
   * Start one text over `unit`.
   *
   * `aspect` is `camera.aspect`, which is the size law's only input besides the category value (see
   * `sizeUnits`), and `unitScale` is the constant-screen-size factor `nameplates.ts` derives.
   */
  spawn(spawn: FloaterSpawn, aspect: number, unitScale: number): void {
    const category = CATEGORIES[spawn.category];
    if (category === undefined || spawn.text === '') {
      return;
    }
    // The pool is bounded; the OLDEST goes. `live` is append-only in spawn order, so index 0 is it.
    if (this.live.length >= MAX_FLOATERS) {
      const oldest = this.live.shift();
      if (oldest) {
        this.retire(oldest);
        this.stats.dropped += 1;
      }
    }

    // THE SETTLED size, which is what the raster is built at -- `t = 1` is past every crit keyframe, so
    // this is `valueHi` for a crit and the constant for every other row.
    const settled = scaleValue(spawn.category, 1);
    // THE OVERRIDE WINS OVER THE ROW, which is the order the reference's branch resolves in: the row
    // colour is the fallback for a NULL override, not a base to be blended with.
    const color = spawn.color ?? category.color;
    const font = this.font(sizeUnits(settled, aspect), aspect, color);
    const resolved = this.fonts.get(spawn.text, font, 1);
    if (resolved?.texture === undefined || resolved.size === undefined) {
      // No raster means no text. Nothing is substituted: a missing glyph run is visibly absent.
      return;
    }
    this.stats.fontLookups += 1;
    // Flipped for a sprite, for the reason `nameplates.ts#setText` states at length: `text.ts` rasterizes
    // with `flipY = false` to match the interface renderer's own UVs, and `THREE.Sprite`'s built-in
    // geometry runs `v = 0` at the BOTTOM. Safe only because this class owns its own cache instance.
    if (resolved.texture.flipY !== true) {
      resolved.texture.flipY = true;
      resolved.texture.needsUpdate = true;
    }

    const sprite = this.pool.pop() ?? this.build();
    const material = sprite.material as THREE.SpriteMaterial;
    material.map = resolved.texture;
    // The emitter's override, or the row's own default. The raster above is built in the same colour,
    // so this multiply is 1.0 and exists only because the pooled material must be reset per spawn.
    const [r, g, b] = argbRgb(color);
    material.color.setRGB(r, g, b);
    material.opacity = 0;
    material.needsUpdate = true;

    // The PAD is part of the quad and not of the layout -- the split `renderer.ts` makes and
    // `nameplates.ts` repeats: `size` is the glyph box, `pad` the outline and shadow clearance.
    const baseW = (resolved.size.width + (resolved.pad?.x ?? 0)) * unitScale;
    const baseH = (resolved.size.height + (resolved.pad?.y ?? 0)) * unitScale;

    sprite.visible = true;
    this.group.add(sprite);
    this.live.push({
      sprite,
      unit: spawn.unit,
      lastX: spawn.unit.position.x,
      lastY: spawn.unit.position.y,
      lastZ: spawn.unit.position.z + overheadAnchor(spawn.unit) + SPAWN_LIFT,
      category,
      categoryIndex: spawn.category,
      ageMs: 0,
      baseW,
      baseH,
      settled,
    });
    this.stats.spawned += 1;
  }

  /** One frame. `dt` is seconds, as `World#animate` passes it everywhere else. */
  update(dt: number, gone: (unit: Unit) => boolean): void {
    const started = performance.now();
    for (let i = this.live.length - 1; i >= 0; --i) {
      const f = this.live[i];
      f.ageMs += dt * 1000;
      if (f.ageMs >= f.category.durMs) {
        this.retire(f);
        this.live.splice(i, 1);
        continue;
      }
      // The victim may have died or streamed out mid-life. Its last anchor is kept rather than the text
      // snapping to the origin -- which is what reading a stale `position` off a disposed unit would do.
      if (f.unit !== null) {
        if (gone(f.unit)) {
          f.unit = null;
        } else {
          f.lastX = f.unit.position.x;
          f.lastY = f.unit.position.y;
          f.lastZ = f.unit.position.z + overheadAnchor(f.unit) + SPAWN_LIFT;
        }
      }
      const t = f.ageMs / f.category.durMs;
      // THE RISE is linear over the full life in WORLD units -- `Category.rise`, `law.rs:6-8` ("rise span,
      // world units over the full duration"). Category 2 (crit) has rise 0: a crit pops in place.
      f.sprite.position.set(f.lastX, f.lastY, f.lastZ + f.category.rise * t);

      const alpha = fadeAlpha(f.category, f.ageMs);
      const material = f.sprite.material as THREE.SpriteMaterial;
      material.opacity = alpha.text / 255;
      // THE CRIT POP, as a sprite SCALE rather than a re-raster -- see the header. A ratio against the
      // settled value the raster was built for, so a non-crit row's factor is exactly 1.
      const factor = f.categoryIndex === CATEGORY_CRIT
        ? scaleValue(f.categoryIndex, t) / f.settled
        : 1;
      f.sprite.scale.set(f.baseW * factor, f.baseH * factor, 1);
    }
    this.stats.live = this.live.length;
    this.stats.updateMs = performance.now() - started;
  }

  /**
   * The font one floater draws in.
   *
   * OUTLINED **and** shadowed. The outline is ours and is the nameplate's reason -- world text is read
   * against arbitrary terrain colour. The SHADOW is the reference's, offset and all
   * (`shadowOffsetUnits`); its alpha is the fade law's plateau ratio `127/255` baked into the raster,
   * which is EXACT during the fade-in and the plateau (both lanes ramp by the same `t`) and too DIM
   * during the fade-out, where the store seam's `min` makes the law's shadow track the text 1:1. A
   * stated approximation, and it errs toward the safe side: the reference's own warning about this seam
   * was a shadow left BRIGHTER than its text -- "the 128-floor black ghost".
   */
  private font(size: number, aspect: number, color: number): FontSpec {
    const [r, g, b] = argbRgb(color);
    const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return {
      family: 'FRIZQT',
      size,
      color: `#${hex(r)}${hex(g)}${hex(b)}`,
      outline: true,
      align: 'CENTER',
      shadowOffset: shadowOffsetUnits(aspect),
      shadowColor: '#000000',
      shadowAlpha: 127 / 255,
    };
  }

  private build(): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      transparent: true,
      // DEPTH-TESTED, no depth WRITE -- the nameplate's own choice and the reference's byte-verified rule
      // for its world-text batch: a wall occludes the number, and two numbers resolve by the transparent
      // pass's sort rather than clipping each other.
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.frustumCulled = false;
    // ABOVE EVERY PLATE, derived rather than copied. This was `10100` against a plate band of
    // `10000 + 0..4`, and when the plates gained a per-plate depth band that literal fell INSIDE it --
    // a plate at depth rank 13 reaches 10104 and would have drawn over the number. Self-review caught
    // it in the same round that introduced it. `PLATE_RENDER_CEILING` is the plates' own maximum, so
    // the separation is now a fact about the code rather than an agreement between two literals.
    //
    // A number that sorts under the brass frame it was lifted clear of would be invisible for the sake
    // of a sort accident -- which is the whole reason this is above them and not merely near them.
    sprite.renderOrder = PLATE_RENDER_CEILING + 1;
    return sprite;
  }

  private retire(f: Floater): void {
    this.group.remove(f.sprite);
    f.sprite.visible = false;
    // The MAP belongs to `FontStringTextures`' cache and is shared by every floater showing the same
    // string -- "37" twice is one raster -- so it is dropped, never disposed.
    (f.sprite.material as THREE.SpriteMaterial).map = null;
    this.pool.push(f.sprite);
  }

  /** `window.combatText()` -- the instrument. */
  report(): unknown {
    return {
      ...this.stats,
      texts: this.live.map((f) => ({
        category: f.categoryIndex,
        ageMs: Math.round(f.ageMs),
        alpha: +((f.sprite.material as THREE.SpriteMaterial).opacity).toFixed(3),
        scale: [+f.sprite.scale.x.toFixed(4), +f.sprite.scale.y.toFixed(4)],
        at: f.sprite.position.toArray().map((v) => +v.toFixed(2)),
      })),
    };
  }

  dispose(): void {
    this.live.forEach((f) => this.retire(f));
    this.live.length = 0;
    this.pool.forEach((sprite) => (sprite.material as THREE.SpriteMaterial).dispose());
    this.pool.length = 0;
    this.group.parent?.remove(this.group);
  }
}
