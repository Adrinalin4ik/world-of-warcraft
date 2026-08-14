/**
 * NAMEPLATES: the unit's name over its head, and -- on the client's own `V` binding -- a health bar and
 * a level.
 *
 * The owner: "нету имени цели и на букву v должен включаться индикатор здоровья с отображение уровня…
 * и нужно оптимально сделать."
 *
 * ## Which MEDIUM, and why it is not a widget
 *
 * **World-pass geometry in the world scene, not a `Widget` in the FrameXML tree.** Three separate
 * things say so and they agree:
 *
 *  1. **The reference.** `samples/benilla/crates/benilla/src/nameplates.rs:1-12` is the overhead-name
 *     system and its first verdict is "World-pass geometry, depth-tested. The name batch is created
 *     depth-test + depth-write ON (`0x6c7470 -> 0x5c1d60(1,1)`) and drawn inside the world/model 3-D
 *     pass -- walls occlude names. So a name here is a real world billboard mesh." Not an inference:
 *     that is the batch the client itself creates.
 *  2. **`CLAUDE.md`'s rule is not violated by it.** The rule is that every screen and frame must be the
 *     client's own XML and Lua. A 3.3.5a nameplate is **engine-created**: it appears in no manifest
 *     file, `worldframe.xml` declares one frame with no regions, and addons reach plates only through
 *     `WorldFrame:GetChildren()`. Drawing one is therefore the ENGINE side of the division, the same
 *     side `drawSweeps` and the selection ring are on -- and the switch is genuinely the client's Lua
 *     (see below). What would violate the rule is hand-building a `Frame` to hold it.
 *  3. **The frame budget, which the owner made a first-class requirement.** The interface renders to an
 *     offscreen target re-rendered only when a fingerprint of the draw list changes, and that is worth
 *     4-7.5 ms on ~92% of frames. A plate that is a widget moves its rect every frame the unit or the
 *     camera moves, so `drawListSignature` would see a change on every such frame and hand the entire
 *     saving back. World geometry is invisible to that fingerprint **by construction** -- the selection
 *     ring's measured zero extra dirty frames is the same argument already checked.
 *
 * The plate is a `THREE.Sprite` stack with `sizeAttenuation` OFF, so it keeps a CONSTANT SCREEN SIZE.
 * That is a deliberate DEPARTURE from the reference and the reason is version: benilla ports 1.12's
 * overhead NAME, which is world-scaled by unit height (`height_scale`, `d/4 * 1.5 * 0.2`), while the
 * thing the owner is describing is 3.3.5a's nameplate FRAME -- a `WorldFrame` child, i.e. a fixed
 * number of pixels however far away the unit is. Constant screen size reproduces that; the height law
 * would shrink it with distance.
 *
 * ## What is engine and what is Lua, exactly
 *
 * The `V` key is **entirely the client's own Lua**. `Interface\FrameXML\Bindings.xml:544-553`:
 *
 *     <Binding name="NAMEPLATES">
 *       local SHOW_ENEMIES = GetCVarBool("nameplateShowEnemies");
 *       ...
 *       SetCVar("nameplateShowEnemies", 1); SetCVar("nameplateShowFriends", 0);
 *     </Binding>
 *
 * so the whole toggle is a real binding running a real chunk, and the engine's part is to READ the two
 * CVars -- which is what `api/screen.ts#cvarBool` exists for. `FRIENDNAMEPLATES` (shift) and
 * `ALLNAMEPLATES` (ctrl) are the same three-way's other rungs and come for free.
 *
 * ## Sourced, and not
 *
 * SOURCED: the CVar names and the toggle's logic (`Bindings.xml`); the font, `NAMEPLATE_FONT =
 * "Fonts\FRIZQT__.TTF"` (`fonts.xml:8`, the client's own declaration); the bar's COLOUR, which is
 * `world/selection-color.ts` -- the reference's verdict is that the name's colour comes from
 * `CGUnit::GetSelectionCircleColor 0x605960`, "the SAME selector as the ground selection ring"
 * (`nameplates.rs:14-27`), and a hand-copied second mirror is a mistake that reference already made and
 * recorded; the "the current TARGET shows regardless of the CVars" rescue (`ShouldShowName 0x6070a0`,
 * `nameplates.rs:38-44`) -- which is precisely the owner's "нету имени цели"; the overhead anchor's
 * FALLBACK formula `feet + scale * bbox_z * 1.25` (`entities.rs:171-174`).
 *
 * NOT SOURCED, and each says so where it is written: every PLATE DIMENSION (bar 110x12 logical units,
 * the fonts' sizes, the gaps), the anchor's extra lift, and the enemy/friendly split's own distance
 * cap. Those are engine constants in the 3.3.5a binary; nothing this project can read states them.
 *
 * NOT PORTED, with reasons: the posed `PlayerName` ATTACHMENT (slot 18, `entities.rs:143-145`) -- our
 * `M2#attachTo` could give it, but it means an `Object3D` per unit inside the skeleton and a per-frame
 * world-matrix update for a two-pixel difference in where the name sits, so the reference's own
 * fallback formula is used instead and this is a stated approximation, not an oversight. The combat
 * flash, the PvP/party colour legs, the `<AFK>/<DND>/<GM>` prefixes and the NPC `<Subname>` line all
 * need feeds this client has none of.
 */
import * as THREE from 'three';

import type Unit from '../classes/unit';
import { FontStringTextures } from '../ui/text';
import type { FontSpec } from '../ui/widget';
import { REACTION_NEUTRAL, reactionFor } from './faction';
import { selectionColor } from './selection-color';

/** `ObjectType` -- 3 Unit (a creature), 4 Player. */
const OBJECT_TYPE_UNIT = 3;
const OBJECT_TYPE_PLAYER = 4;

/**
 * The reference's overhead-anchor FALLBACK factor (`entities.rs:173`, `OVERHEAD_FALLBACK_FACTOR`):
 * `feet + scale * bbox_z * 1.25`. Used here for every unit -- see this file's header for why the posed
 * attachment is not.
 */
const OVERHEAD_FALLBACK_FACTOR = 1.25;

/**
 * The logical (768-space) height a plate's whole stack occupies, and the pieces of it.
 *
 * **EVERY NUMBER HERE IS OURS.** A 3.3.5a nameplate's geometry is engine layout: it is not in
 * `worldframe.xml` (2592 bytes, one frame, no regions), it is in no other manifest file, and there is
 * no DBC for it. They are chosen to read like the real plate at 1382x911 and they are labelled rather
 * than dressed up with a citation. `NAMEPLATE_FONT` is the one part that IS sourced (`fonts.xml:8`).
 */
const PLATE = {
  barWidth: 110,
  barHeight: 12,
  /** The bar's dark surround, per side. */
  barBorder: 1,
  nameSize: 12,
  levelSize: 11,
  /** Between the name's baseline block and the top of the bar. */
  nameGap: 2,
  /** Between the bar's right edge and the level number. */
  levelGap: 4,
  /** How far the bar's bottom edge sits above the overhead anchor. */
  lift: 6,
} as const;

/**
 * The nameplate font. `fonts.xml:8` declares `NAMEPLATE_FONT = "Fonts\FRIZQT__.TTF"` -- the client's
 * own name for this exact use, and FRIZQT is one of the three faces that register here (SKURRI does
 * not; see `STATE.md`). OUTLINED rather than shadowed, because a plate is read against arbitrary world
 * colour rather than against interface art; the SIZE and that choice are ours.
 */
function plateFont(size: number, color: string): FontSpec {
  return { family: 'FRIZQT', size, color, outline: true, align: 'CENTER' };
}

/** One unit's plate: the sprites, and the last content each was built for. */
interface Plate {
  group: THREE.Group;
  name: THREE.Sprite;
  level: THREE.Sprite;
  barBack: THREE.Sprite;
  barFill: THREE.Sprite;
  /** The strings the two text sprites were last rasterized for, so a static plate re-rasterizes never. */
  builtName: string;
  builtLevel: string;
  /** Was this plate touched this frame? Untouched plates are hidden at the end of the pass. */
  seen: boolean;
}

/**
 * `Unit#name`'s own default, before `SMSG_CREATURE_QUERY_RESPONSE` answers.
 *
 * A plate with this in it is a plate whose name has not arrived, and drawing the placeholder would be a
 * screen that renders plausibly and wrongly -- so the name line is simply absent until the reply lands.
 * A creature has no `UNIT_FIELD_NAME`: the name lives in that query and nowhere else.
 */
const UNNAMED = '<unknown>';

/**
 * The `builtName`/`builtLevel` sentinel: a value no real name or level can equal, so the FIRST pass over
 * a new plate always rasterizes even when the name is legitimately the empty string.
 *
 * Explicit rather than `''`, which a not-yet-named creature genuinely has (see `UNNAMED`) and which would
 * therefore leave its name sprite un-built for ever once the query answered.
 */
const NEVER_BUILT = ' never-built';

/** What the pass needs to know that is not on a `Unit`. */
export interface NameplateConfig {
  /** `GetCVarBool("nameplateShowEnemies")` -- attackable units get a bar and a level. */
  showEnemies: boolean;
  /** `GetCVarBool("nameplateShowFriends")`. */
  showFriends: boolean;
}

/**
 * How far a plate is drawn, in yards.
 *
 * **OURS.** The real client has a `nameplateMaxDistance` the options panel does not expose in 3.3.5a
 * and no file states its value. 41 is taken from `pick.ts#PICK_RANGE`, itself the reference's
 * `targetNearestDistance` -- so the plate's reach is the same as TAB's, which is at least a coherent
 * choice rather than an invented number, and it is the bound that keeps the draw-call count finite.
 */
export const PLATE_RANGE = 41;

/** A plate is at most this many, whatever is in range -- the draw-call bound. OURS. */
const MAX_PLATES = 20;

export class Nameplates {
  private readonly group = new THREE.Group();

  private readonly plates = new Map<string, Plate>();

  private readonly fonts = new FontStringTextures();

  /** One 1x1 white texel, shared by both bar sprites; the colour is the material's. */
  private solid: THREE.DataTexture | null = null;

  /** `window.worldNameplates` -- the pass's own numbers. See `report`. */
  readonly stats = {
    plates: 0,
    drawCalls: 0,
    updateMs: 0,
    /** How many text rasterizations this pass did. Should be 0 in the steady state. */
    rasterized: 0,
    showEnemies: false,
    showFriends: false,
  };

  constructor(scene: THREE.Scene) {
    this.group.name = 'Nameplates';
    // The plates live in the world scene, so `drawListSignature` cannot see them. That is the whole
    // efficiency argument in one line -- see this file's header.
    scene.add(this.group);
  }

  /**
   * One frame of plates.
   *
   * `camera` is needed for the constant-screen-size scale: with `sizeAttenuation` off three multiplies
   * a sprite's scale by the view depth, so a scale of `f * 2 * tan(fov/2)` occupies exactly the
   * fraction `f` of the viewport height at any distance.
   */
  update(
    entities: Iterable<Unit>,
    self: Unit | null,
    target: Unit | null,
    camera: THREE.PerspectiveCamera,
    config: NameplateConfig,
    /**
     * Ask the server for a creature template's name -- `CombatHandler#queryCreature`, passed in so this
     * module keeps no dependency on the network layer (the same division `movement/` uses for its casts).
     *
     * Round 20 deferred nameplates partly on "names for every unit in view need `SMSG_CREATURE_QUERY`
     * per unit, ~40 round trips a grid". That is **not what it costs**: the query is keyed on the
     * TEMPLATE `entry`, `CombatHandler#asked` dedupes on it, and `applyCreatureInfo` writes the answer
     * onto EVERY unit sharing that entry -- so a camp of eleven identical wolves is ONE round trip and a
     * Northshire grid is a handful.
     */
    queryName: ((entry: number, guid: string) => void) | null,
  ): void {
    const started = performance.now();
    this.stats.rasterized = 0;
    this.stats.showEnemies = config.showEnemies;
    this.stats.showFriends = config.showFriends;
    this.plates.forEach((plate) => { plate.seen = false; });

    // The scale that makes one logical (768-space) unit one logical unit on screen, whatever the depth.
    const unitScale = (2 * Math.tan((camera.fov * Math.PI) / 360)) / 768;
    let shown = 0;

    for (const unit of entities) {
      if (shown >= MAX_PLATES) {
        break;
      }
      const decision = this.wants(unit, self, target, config);
      if (decision === null) {
        continue;
      }
      shown += 1;
      if (queryName !== null && unit.name === UNNAMED && unit.fields.entry) {
        queryName(unit.fields.entry, unit.guid);
      }
      this.place(unit, decision.bar, unitScale, self);
    }

    let calls = 0;
    this.plates.forEach((plate, guid) => {
      if (plate.seen) {
        calls += plate.group.children.filter((child) => child.visible).length;
        return;
      }
      // GONE, not merely out of range: dispose it rather than leaving it hidden. A world session
      // streams hundreds of units through a grid and a hidden sprite still holds a canvas texture.
      this.destroy(plate);
      this.plates.delete(guid);
    });

    this.stats.plates = shown;
    this.stats.drawCalls = calls;
    this.stats.updateMs = performance.now() - started;
  }

  /**
   * Should this unit have a plate, and does it get the bar and level?
   *
   * THE TARGET RESCUE IS FIRST, and it is the owner's actual complaint: `ShouldShowName 0x6070a0`'s own
   * rule is that "the current TARGET shows regardless of cvars" (`nameplates.rs:41-42`). So a name over
   * whatever is selected is not a setting -- it is the client's behaviour with every nameplate CVar off.
   *
   * `null` = no plate.
   */
  private wants(
    unit: Unit,
    self: Unit | null,
    target: Unit | null,
    config: NameplateConfig,
  ): { bar: boolean } | null {
    if (unit === self || !unit.view.visible) {
      return null;
    }
    if (unit.objectType !== OBJECT_TYPE_UNIT && unit.objectType !== OBJECT_TYPE_PLAYER) {
      return null;
    }
    if (self !== null) {
      const dx = unit.position.x - self.position.x;
      const dy = unit.position.y - self.position.y;
      if (dx * dx + dy * dy > PLATE_RANGE * PLATE_RANGE) {
        return null;
      }
    }
    // Attackable INCLUDES NEUTRAL, which is `canAttackUnit`'s gate and the same one the right-click
    // attack and the Attack cursor use -- so Northshire's neutral wolves are "enemies" for the enemy
    // plate, which is what the real client does too (the set is "units you can attack").
    const reaction = reactionFor(unit, self) ?? REACTION_NEUTRAL;
    const attackable = reaction <= REACTION_NEUTRAL;
    if (attackable ? config.showEnemies : config.showFriends) {
      return { bar: true };
    }
    // THE RESCUE. A name, no bar -- the target is named whatever the CVars say.
    if (unit === target) {
      return { bar: config.showEnemies || config.showFriends };
    }
    return null;
  }

  /** Build or update one unit's plate and put it where the unit's head is. */
  private place(unit: Unit, bar: boolean, unitScale: number, self: Unit | null): void {
    const plate = this.plateFor(unit.guid);
    plate.seen = true;

    // THE ANCHOR: the reference's own fallback, `feet + scale * bbox_z * 1.25`. The M2 file's vertical
    // component is index 2 (round 22 established that the horizontal pair is 0 and 1, which is what
    // makes `ringFootprint` read the right two), and `minVertexBox`/`maxVertexBox` are the header boxes
    // -- our parser's two box names are SWAPPED relative to benilla's, so reading `boundingBox` here
    // would size off the collision post. Falls back to `collisionHeight`, which is the unit's own
    // measured height, for a unit whose model has not arrived.
    // `collisionHeight` FIRST and the vertex box only as a backstop, which is a DEPARTURE from the
    // reference's `bbox_z` and is measured, not preferred: the M2 header's vertex box bounds EVERY pose
    // the model has, so for a wolf it is the rearing/leaping extent rather than the standing head, and
    // the first capture of this gate put the plate about **1.2 yd above the animal's head**.
    // `collisionHeight` is `CreatureModelData.collisionHeight x displayScale` (`unit.ts:511-514`) -- the
    // unit's own STANDING height, the value movement resolves the ground against. The reference does not
    // face this choice because it reads the posed attachment, which is the real answer and is not ported
    // (see the header).
    const model = unit.model as unknown as { scale?: THREE.Vector3; data?: { maxVertexBox?: { z: number } } } | null;
    const boxZ = model?.data?.maxVertexBox?.z ?? 0;
    const modelScale = model?.scale?.x ?? 1;
    const height = unit.collisionHeight > 0
      ? unit.collisionHeight * OVERHEAD_FALLBACK_FACTOR
      : boxZ * modelScale * OVERHEAD_FALLBACK_FACTOR;
    plate.group.position.set(unit.position.x, unit.position.y, unit.position.z + height);

    const reaction = reactionFor(unit, self) ?? REACTION_NEUTRAL;
    const [r, g, b] = selectionColor(reaction, unit.isPlayer, unit.dead);

    // TEXT IS RASTERIZED ONLY WHEN IT CHANGES. `FontStringTextures` caches by content, but even a cache
    // hit is a map lookup and a string build per plate per frame; comparing the string first makes the
    // steady state one comparison. `stats.rasterized` is the instrument that says whether it holds.
    const label = unit.name === UNNAMED ? '' : unit.name;
    if (label !== plate.builtName) {
      plate.builtName = label;
      this.stats.rasterized += 1;
      this.setText(plate.name, label, plateFont(PLATE.nameSize, '#ffffff'), unitScale);
    }
    // The NAME's colour is the reaction, through the one selector -- see the header. On the material,
    // not baked into the raster, so a reaction change costs no re-rasterize.
    (plate.name.material as THREE.SpriteMaterial).color.setRGB(r, g, b);

    const nameSize = plate.name.scale;
    // Stacked with `Sprite#center`, not with world offsets. Every sprite in a plate sits at the SAME
    // world anchor and `center` shifts it by a fraction of its OWN size -- which is a screen-space
    // shift by construction, so the stack cannot come apart at a different distance or a different
    // window height. A world-space offset would have to be recomputed from the camera depth every
    // frame and would tilt with the camera's up vector.
    const lift = PLATE.lift * unitScale;
    const barH = (PLATE.barHeight + 2 * PLATE.barBorder) * unitScale;

    if (bar) {
      const barW = (PLATE.barWidth + 2 * PLATE.barBorder) * unitScale;
      plate.barBack.visible = true;
      plate.barBack.scale.set(barW, barH, 1);
      plate.barBack.center.set(0.5, -lift / barH);

      const maxHealth = unit.fields.maxHealth ?? 0;
      const fraction = maxHealth > 0 ? Math.max(0, Math.min(1, (unit.fields.health ?? 0) / maxHealth)) : 0;
      const fillW = PLATE.barWidth * unitScale * fraction;
      plate.barFill.visible = fraction > 0;
      plate.barFill.scale.set(Math.max(fillW, 1e-6), PLATE.barHeight * unitScale, 1);
      // GROWS FROM THE LEFT, and the sign here is a defect the gate's first screenshot caught: a sprite
      // with `center.x = c` spans `position.x - c*w` to `position.x + (1-c)*w`, so pinning its LEFT edge
      // at `-innerWidth/2` needs `c = +innerWidth/(2*w)`. Negative put the fill to the RIGHT of centre
      // and it read as a bar draining the wrong way.
      const inner = PLATE.barWidth * unitScale;
      plate.barFill.center.set(
        inner / 2 / Math.max(fillW, 1e-6),
        -(lift + PLATE.barBorder * unitScale) / (PLATE.barHeight * unitScale),
      );
      (plate.barFill.material as THREE.SpriteMaterial).color.setRGB(r, g, b);

      const levelText = unit.level > 0 ? String(unit.level) : '';
      if (levelText !== plate.builtLevel) {
        plate.builtLevel = levelText;
        this.stats.rasterized += 1;
        this.setText(plate.level, levelText, plateFont(PLATE.levelSize, '#ffd200'), unitScale);
      }
      plate.level.visible = levelText !== '';
      if (plate.level.visible) {
        const levelW = plate.level.scale.x;
        const levelH = plate.level.scale.y;
        plate.level.center.set(
          -(barW / 2 + PLATE.levelGap * unitScale) / levelW,
          -(lift + (barH - levelH) / 2) / levelH,
        );
      }
    } else {
      plate.barBack.visible = false;
      plate.barFill.visible = false;
      plate.level.visible = false;
    }

    plate.name.visible = nameSize.x > 0 && label !== '';
    // The name sits above the bar when there is one, and on the anchor when there is not.
    const nameBottom = lift + (bar ? barH + PLATE.nameGap * unitScale : 0);
    plate.name.center.set(0.5, -nameBottom / Math.max(nameSize.y, 1e-6));
  }

  /** Rasterize a string onto a sprite, sizing the sprite to the raster's own logical extent. */
  private setText(sprite: THREE.Sprite, text: string, spec: FontSpec, unitScale: number): void {
    const resolved = text === '' ? null : this.fonts.get(text, spec, 1);
    const material = sprite.material as THREE.SpriteMaterial;
    if (resolved?.texture === undefined || resolved.size === undefined) {
      material.map = null;
      sprite.visible = false;
      sprite.scale.set(1e-6, 1e-6, 1);
      return;
    }
    // THE TEXTURE IS FLIPPED FOR A SPRITE, and the gate's first screenshot is what found it: every string
    // came out MIRRORED VERTICALLY. `text.ts:470` sets `flipY = false` on every rasterized string,
    // deliberately -- the interface renderer's own quads carry UVs to match, and CLAUDE.md's uniform
    // orientation rule means nothing in this codebase relies on three's default. `THREE.Sprite`'s
    // built-in geometry does: its UVs run `v = 0` at the BOTTOM, which is the `flipY = true` convention.
    //
    // Safe to flip here ONLY because this class owns its own `FontStringTextures` -- the interface's
    // cache is a different instance, so nothing else serves these entries and this cannot invert a
    // FontString on screen. Set once per entry, guarded, because `needsUpdate` forces a re-upload.
    if (resolved.texture.flipY !== true) {
      resolved.texture.flipY = true;
      resolved.texture.needsUpdate = true;
    }
    material.map = resolved.texture;
    material.needsUpdate = true;
    // THE PAD IS PART OF THE QUAD, not of the layout -- the same split `renderer.ts` makes. `size` is
    // the glyph box and `pad` is the outline's clearance around it; drawing the quad at `size` alone
    // would squeeze the raster and clip the ring.
    const width = (resolved.size.width + (resolved.pad?.x ?? 0)) * unitScale;
    const height = (resolved.size.height + (resolved.pad?.y ?? 0)) * unitScale;
    sprite.scale.set(width, height, 1);
    sprite.visible = true;
  }

  private plateFor(guid: string): Plate {
    const existing = this.plates.get(guid);
    if (existing) {
      return existing;
    }
    const group = new THREE.Group();
    group.matrixAutoUpdate = true;
    const barBack = this.sprite(0.35, 0, 0, 0);
    const barFill = this.sprite(1, 1, 1, 1);
    const name = this.sprite(0, 1, 1, 1, true);
    const level = this.sprite(0, 1, 1, 1, true);
    group.add(barBack, barFill, name, level);
    this.group.add(group);
    const plate: Plate = {
      group, name, level, barBack, barFill, builtName: NEVER_BUILT, builtLevel: NEVER_BUILT, seen: true,
    };
    this.plates.set(guid, plate);
    return plate;
  }

  /**
   * One sprite.
   *
   * `sizeAttenuation: false` is what makes a plate a constant number of pixels -- see the header.
   * DEPTH-TESTED, which is the reference's byte-verified rule for the overhead-name batch ("walls
   * occlude names", `nameplates.rs:5-7`); it deliberately does NOT depth-WRITE, so two plates that
   * overlap resolve by the transparent pass's own sort rather than clipping each other, which is the
   * same named divergence the reference records for itself.
   */
  private sprite(alpha: number, r: number, g: number, b: number, textured = false): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      map: textured ? null : this.solidTexture(),
      color: new THREE.Color(r, g, b),
      transparent: true,
      opacity: textured ? 1 : alpha,
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.frustumCulled = false;
    // After the ordinary transparents. The reference biases its name batch to the top rung of its own
    // sort ladder for the same reason (`NAMEPLATE_DEPTH_BIAS`, `nameplates.rs:79-88`): world text that
    // sorts under a water surface is text nobody can read.
    sprite.renderOrder = 10000;
    return sprite;
  }

  private solidTexture(): THREE.DataTexture {
    if (this.solid === null) {
      const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      texture.needsUpdate = true;
      this.solid = texture;
    }
    return this.solid;
  }

  private destroy(plate: Plate): void {
    this.group.remove(plate.group);
    [plate.name, plate.level, plate.barBack, plate.barFill].forEach((sprite) => {
      // The MAP is NOT disposed: it belongs to `FontStringTextures`' cache and is shared by every plate
      // showing the same string -- eleven identical wolves are one raster.
      (sprite.material as THREE.SpriteMaterial).dispose();
    });
  }

  /** `window.worldNameplates()` -- the instrument. */
  report(): unknown {
    return {
      ...this.stats,
      units: [...this.plates.entries()].map(([guid, plate]) => ({
        guid,
        name: plate.builtName,
        level: plate.builtLevel,
        bar: plate.barBack.visible,
        barFillFraction: plate.barBack.visible && plate.barBack.scale.x > 0
          ? +(plate.barFill.scale.x / (plate.barBack.scale.x - 2e-6 || 1)).toFixed(3)
          : null,
        at: plate.group.position.toArray().map((v) => +v.toFixed(2)),
      })),
    };
  }

  dispose(): void {
    this.plates.forEach((plate) => this.destroy(plate));
    this.plates.clear();
    this.solid?.dispose();
    this.solid = null;
    this.group.parent?.remove(this.group);
  }
}
