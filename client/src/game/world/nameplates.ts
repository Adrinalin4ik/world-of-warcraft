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
 * SOURCED:
 *
 *  - **The plate's whole GEOMETRY, decoded out of `interface/tooltips/nameplate-border.blp`** -- the
 *    frame, the bar's inset hole and the level slot. See `ART`; this replaced a first version that
 *    invented every dimension and drew a flat rectangle, which is what the owner reported as "В
 *    оригинале она по другому выглядит".
 *  - The CVar names and the toggle's logic (`Bindings.xml:544-573`).
 *  - The font: `NAMEPLATE_FONT = "Fonts\FRIZQT__.TTF"` (`fonts.xml:8`), the client's own declaration.
 *  - **The BAR's colour**: `world/selection-color.ts`, which the reference states literally is "the SAME
 *    selector as the ground selection ring" (`nameplates.rs:14-27`) -- and a hand-copied second mirror is
 *    a mistake that reference already made and recorded. Corroborated against three of the owner's own
 *    reference crops: neutral yellow, friendly-NPC green, friendly-player blue.
 *  - **The NAME's colour is WHITE on a nameplate** and reaction-coloured only on a bare overhead name.
 *    Those are two systems; see the comment at the `nameMaterial` write for the evidence on both sides.
 *  - **The LEVEL number's colour is the client's own difficulty ramp**, reached through its own
 *    `GetQuestDifficultyColor` (`uiparent.lua:3358-3371`) rather than a copy -- the call
 *    `targetframe.lua:246-251` makes for exactly this question. See `NameplateConfig.levelColor`.
 *  - The "current TARGET shows regardless of the CVars" rescue (`ShouldShowName 0x6070a0`,
 *    `nameplates.rs:38-44`) -- precisely the owner's "нету имени цели".
 *  - The overhead anchor's FALLBACK formula `feet + scale * bbox_z * 1.25` (`entities.rs:171-174`).
 *
 * NOT SOURCED, and each says so where it is written: the two FONT SIZES, the gap between the name and
 * the frame, the lift above the anchor, `PLATE_RANGE`, `MAX_PLATES`, and the depleted bar's dark backing
 * colour. Those are engine constants in the 3.3.5a binary; nothing this project can read states them.
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
import TextureLoader from '../pipeline/texture-loader';
import { PRIORITY } from '../pipeline/worker/pool';
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
 * HOW FAR ABOVE A UNIT'S FEET ITS OVERHEAD ANCHOR SITS, in world units.
 *
 * `collisionHeight` FIRST and the vertex box only as a backstop, which is a DEPARTURE from the
 * reference's `bbox_z` and is measured, not preferred: the M2 header's vertex box bounds EVERY pose the
 * model has, so for a wolf it is the rearing/leaping extent rather than the standing head, and the first
 * capture of the plate gate put the plate about **1.2 yd above the animal's head**. `collisionHeight` is
 * `CreatureModelData.collisionHeight x displayScale` (`unit.ts:511-514`) -- the unit's own STANDING
 * height, the value movement resolves the ground against. The reference does not face this choice
 * because it reads the posed `PlayerName` attachment, which is the real answer and is not ported (see
 * this file's header).
 *
 * EXPORTED because the floating combat text spawns from the same anchor (`world/floating-text.ts`), and
 * a second hand-written copy of this choice is how the two would drift apart.
 */
export function overheadAnchor(unit: Unit): number {
  const model = unit.model as unknown as {
    scale?: THREE.Vector3; data?: { maxVertexBox?: { z: number } };
  } | null;
  const boxZ = model?.data?.maxVertexBox?.z ?? 0;
  const modelScale = model?.scale?.x ?? 1;
  return unit.collisionHeight > 0
    ? unit.collisionHeight * OVERHEAD_FALLBACK_FACTOR
    : boxZ * modelScale * OVERHEAD_FALLBACK_FACTOR;
}

/**
 * THE PLATE'S GEOMETRY, **DECODED OUT OF THE AUTHORED ART** rather than eyeballed from a screenshot.
 *
 * The first version of this file drew a flat rectangle and invented every dimension. The owner's answer
 * was "В оригинале она по другому выглядит", and he was right: `interface/tooltips/nameplate-border.blp`
 * is served (200, 6676 B) and it carries the whole layout, the same way `unitselecttexture.blp` turned
 * out to carry the selection ring's fade. Decoded off the served file (BLP2, `colorEncoding` 2 = DXT,
 * `alphaSize` 8 with `alphaEncoding` 1 = **DXT3**, 128x32, 8 mip levels):
 *
 *  - **Rows 0-14 are entirely EMPTY** -- mean alpha 0 across all 128 columns. The authored frame is the
 *    BOTTOM **128 x 17** texels of the file, which is why the border sprite carries a sub-rect.
 *  - Across the middle inked row (y=23) the alpha runs `ink 0..4`, `gap 5..105`, `ink 106..127`. So the
 *    frame is **two cells**: a wide one whose interior is TRANSPARENT -- the hole the status bar shows
 *    through -- and a narrow one at the right whose interior is FILLED opaque brass, sampled
 *    `(139,103,5)` at alpha 238. **That narrow filled cell IS the level slot**, which answers the
 *    owner's second point: the level belongs inside a boxed cell at the bar's right-hand end, not
 *    floating outside it. It needed no box of ours.
 *  - Vertically the transparent interior is rows **20..26** -- 7 texels -- with 5 border rows above and
 *    5 below. So the fill is inset 5 texels on every side and does NOT reach the frame's edge, which is
 *    the owner's fourth point and was not guessed at either.
 *
 * The plate is drawn at the art's OWN TEXEL SIZE in logical units (128 x 17). That is the one dimension
 * here that is a choice rather than a measurement -- but it is a choice between the authored size and an
 * invented one.
 *
 * `interface/targetingframe/ui-statusbar.blp` (200, 1532 B) is the fill: BLP2 DXT1, **64x8, `alphaSize`
 * 0 so fully opaque**, and its 64 columns are identical -- a purely VERTICAL greyscale gradient,
 * measured down a column as `139, 194, 222, 194, 148, 104, 126, 104`. It carries no colour of its own,
 * so like the ring's texture it is a shape tinted by the reaction colour.
 *
 * Still OURS and labelled: the two font sizes, the gap between name and frame, the lift above the
 * anchor, `PLATE_RANGE`, `MAX_PLATES`.
 */
const ART = {
  /** The file is 128x32; only the bottom 17 rows are inked. */
  fileHeight: 32,
  frameWidth: 128,
  frameHeight: 17,
  /** The transparent interior, in texels within the 128x17 frame -- the status bar's hole. */
  barLeft: 5,
  barTop: 5,
  barWidth: 101,
  barHeight: 7,
  /** The filled brass cell at the right-hand end: the LEVEL SLOT. */
  slotLeft: 106,
  slotWidth: 22,
} as const;

const PLATE = {
  nameSize: 12,
  levelSize: 10,
  /** Between the name's glyph block and the top of the frame. OURS. */
  nameGap: 1,
  /** How far the frame's bottom edge sits above the overhead anchor. OURS. */
  lift: 6,
} as const;

/** `interface/tooltips/nameplate-border.blp` -- see `ART`. Lowercase: the asset host serves nothing else. */
const BORDER_TEXTURE = 'interface/tooltips/nameplate-border.blp';

/** `interface/targetingframe/ui-statusbar.blp` -- the bar's own shading. See `ART`. */
const BAR_TEXTURE = 'interface/targetingframe/ui-statusbar.blp';

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
  /** The AUTHORED frame -- `interface/tooltips/nameplate-border.blp`. Drawn OVER the fill; see `ART`. */
  border: THREE.Sprite;
  /** The strings the two text sprites were last rasterized for, so a static plate re-rasterizes never. */
  builtName: string;
  builtLevel: string;
  /** Was this plate touched this frame? Untouched plates are hidden at the end of the pass. */
  seen: boolean;
  /**
   * The health fraction the fill was last sized for, 0..1, or null when the bar is hidden.
   *
   * Stored rather than re-derived in `report()`. Self-review's finding: the first version divided the
   * fill sprite's scale by the BACK sprite's -- which differ by the border -- and the correction term it
   * carried was meaningless. An instrument reporting a number nobody could check.
   */
  fraction: number | null;
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
const NEVER_BUILT = '<never-built>';

/** What the pass needs to know that is not on a `Unit`. */
export interface NameplateConfig {
  /** `GetCVarBool("nameplateShowEnemies")` -- attackable units get a bar and a level. */
  showEnemies: boolean;
  /** `GetCVarBool("nameplateShowFriends")`. */
  showFriends: boolean;
  /**
   * `GetQuestDifficultyColor(level)` -- the colour the CLIENT'S OWN LUA gives a level number, as
   * `[r, g, b]`; null when the runtime is not up.
   *
   * A DOOR rather than a second copy of the ramp, and that is the point. The ramp is authored in the
   * client's own Lua: `uiparent.lua:3358-3371` is
   *
   *     function GetQuestDifficultyColor(level)
   *       local levelDiff = level - UnitLevel("player");
   *       if     ( levelDiff >= 5 )  then return QuestDifficultyColors["impossible"];     -- 1.00,0.10,0.10
   *       elseif ( levelDiff >= 3 )  then return QuestDifficultyColors["verydifficult"];  -- 1.00,0.50,0.25
   *       elseif ( levelDiff >= -2 ) then return QuestDifficultyColors["difficult"];      -- 1.00,1.00,0.00
   *       elseif ( -levelDiff <= GetQuestGreenRange() ) then return ...["standard"];       -- 0.25,0.75,0.25
   *       else   return QuestDifficultyColors["trivial"];                                 -- 0.50,0.50,0.50
   *
   * with the five colours in `constants.lua:403`'s `QuestDifficultyColors`. **`targetframe.lua:246-251`
   * is the proof this is the right question rather than a plausible one**: the client colours a UNIT'S
   * LEVEL NUMBER with exactly this call --
   * `local color = GetQuestDifficultyColor(targetLevel); self.levelText:SetVertexColor(...)` -- and its
   * `else` branch gives a NON-attackable unit a flat `(1.0, 0.82, 0.0)` instead.
   *
   * `lua/api/units.ts` already runs that function in Lua so the colours are read out of the client's own
   * table rather than transcribed; going through it means there is exactly one copy of the ramp, which
   * is what the reference records having got wrong for the ring's colour.
   */
  levelColor: ((level: number) => [number, number, number] | null) | null;
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
    // THE RAMP'S OTHER OPERAND, read once per pass. A level-up invalidates every memoized tint, which is
    // why `levelTint`'s key carries it rather than only the unit's own level.
    const mine = self?.level ?? 0;
    if (mine !== this.selfLevel) {
      this.selfLevel = mine;
      this.levelTints.clear();
    }
    this.plates.forEach((plate) => { plate.seen = false; });

    // The scale that makes one logical (768-space) unit one logical unit on screen, whatever the depth.
    // CONSTANT IN PRACTICE -- it depends only on `camera.fov` and the fixed 768, not on the viewport --
    // which matters because `setText` bakes it into a text sprite's scale and only re-runs when the
    // STRING changes. A live fov change (nothing here does one; `resize` writes only `aspect`) would
    // leave existing text at the old scale until its string changed. Named rather than guarded against,
    // because a guard for a case that cannot happen is a guard nobody can test.
    const unitScale = (2 * Math.tan((camera.fov * Math.PI) / 360)) / 768;
    let shown = 0;
    const consider = (unit: Unit): void => {
      if (shown >= MAX_PLATES || this.plates.get(unit.guid)?.seen === true) {
        return;
      }
      const decision = this.wants(unit, self, target, config);
      if (decision === null) {
        return;
      }
      shown += 1;
      if (queryName !== null && unit.name === UNNAMED && unit.fields.entry) {
        queryName(unit.fields.entry, unit.guid);
      }
      this.place(unit, decision.bar, unitScale, self, this.levelTint(unit, config));
    };

    // THE TARGET FIRST, and self-review is what found this: `MAX_PLATES` is a hard break, so a grid with
    // twenty attackable units ahead of the target in the entity map would have dropped the target's own
    // plate -- the one plate the reference says shows unconditionally. The `seen` guard in `consider` is
    // what stops the main loop then drawing it twice.
    if (target !== null) {
      consider(target);
    }
    for (const unit of entities) {
      if (shown >= MAX_PLATES) {
        break;
      }
      consider(unit);
    }

    let calls = 0;
    this.plates.forEach((plate, guid) => {
      if (plate.seen) {
        // A LOOP, not `children.filter(...).length`: the instrument runs per plate per frame and an array
        // allocation there is exactly the per-frame garbage round 22's self-review took out of the ring.
        for (let i = 0; i < plate.group.children.length; ++i) {
          if (plate.group.children[i].visible) {
            calls += 1;
          }
        }
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
  private place(
    unit: Unit,
    bar: boolean,
    unitScale: number,
    self: Unit | null,
    levelTint: [number, number, number],
  ): void {
    const plate = this.plateFor(unit.guid);
    plate.seen = true;

    // THE ANCHOR -- `overheadAnchor`, which is now shared with the floating combat text; the choice and
    // its measurement are documented there.
    const height = overheadAnchor(unit);
    plate.group.position.set(unit.position.x, unit.position.y, unit.position.z + height);

    const reaction = reactionFor(unit, self) ?? REACTION_NEUTRAL;
    // THE BAR'S colour, from the one selector `selection-color.ts` holds -- the reference's literal claim
    // is that a plate reads "the SAME selector as the ground selection ring" (`nameplates.rs:14-27`).
    // Corroborated against three of the owner's own reference crops with nothing tuned: a NEUTRAL wolf
    // yellow, a FRIENDLY guard green, a friendly PLAYER soft blue -- reactions 4, >=5 and the player
    // branch, i.e. three rungs of one ladder rather than three cases to special-case.
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

    // THE NAME'S COLOUR SPLITS BY WHICH SYSTEM IS DRAWING, and the first version got it wrong by giving
    // both the reaction colour.
    //
    // **A NAMEPLATE'S NAME IS WHITE.** Evidenced by three of the owner's reference crops covering all
    // three bar colours -- a yellow-barred neutral wolf, a green-barred friendly guard and a blue-barred
    // friendly player -- and the name is white in every one. Colouring it by reaction is what made ours
    // read as one yellow mass instead of a label over a bar.
    //
    // **A BARE OVERHEAD NAME IS REACTION-COLOURED**, and that is a DIFFERENT SYSTEM rather than an
    // inconsistency: it is the 1.12 overhead-NAME batch, whose colour the reference byte-verified as
    // `GetSelectionCircleColor` after an A/B "falsified the earlier 'constant white'"
    // (`nameplates.rs:14-20`). Here that case is exactly the target rescue -- name, no bar -- so the two
    // rules never apply to the same thing on screen.
    const nameMaterial = plate.name.material as THREE.SpriteMaterial;
    if (bar) {
      nameMaterial.color.setRGB(1, 1, 1);
    } else {
      nameMaterial.color.setRGB(r, g, b);
    }

    const nameSize = plate.name.scale;
    // Stacked with `Sprite#center`, not with world offsets. Every sprite in a plate sits at the SAME
    // world anchor and `center` shifts it by a fraction of its OWN size -- which is a screen-space
    // shift by construction, so the stack cannot come apart at a different distance or a different
    // window height. A world-space offset would have to be recomputed from the camera depth every
    // frame and would tilt with the camera's up vector.
    const lift = PLATE.lift * unitScale;
    // THE FRAME, at the art's own texel size. Every offset below is measured off the decoded file; see
    // `ART`. `frameH` is the 17 INKED rows, not the file's 32.
    const frameW = ART.frameWidth * unitScale;
    const frameH = ART.frameHeight * unitScale;

    if (bar) {
      plate.border.visible = true;
      plate.border.scale.set(frameW, frameH, 1);
      plate.border.center.set(0.5, -lift / frameH);

      // THE BAR'S HOLE in the frame, in measured texels: x 5..105, and rows 5..11 counted DOWN from the
      // frame's top. Converted to a bottom-up offset because `Sprite#center` is a fraction of the
      // sprite's own size measured from its bottom-left.
      const holeW = ART.barWidth * unitScale;
      const holeH = ART.barHeight * unitScale;
      const holeLeft = (ART.barLeft - ART.frameWidth / 2) * unitScale;
      const holeBottom = lift + (ART.frameHeight - ART.barTop - ART.barHeight) * unitScale;

      plate.barBack.visible = true;
      plate.barBack.scale.set(holeW, holeH, 1);
      plate.barBack.center.set(-holeLeft / holeW, -holeBottom / holeH);

      const maxHealth = unit.fields.maxHealth ?? 0;
      const fraction = maxHealth > 0 ? Math.max(0, Math.min(1, (unit.fields.health ?? 0) / maxHealth)) : 0;
      plate.fraction = fraction;
      const fillW = holeW * fraction;
      plate.barFill.visible = fraction > 0;
      plate.barFill.scale.set(Math.max(fillW, 1e-6), holeH, 1);
      // GROWS FROM THE LEFT of the hole. The sign here is a defect an earlier screenshot caught: a sprite
      // with `center.x = c` spans `position.x - c*w` to `position.x + (1-c)*w`, so pinning its LEFT edge
      // at `holeLeft` needs `c = -holeLeft/w`. Inverted, the fill sat right of centre and read as a bar
      // draining the wrong way.
      plate.barFill.center.set(-holeLeft / Math.max(fillW, 1e-6), -holeBottom / holeH);
      (plate.barFill.material as THREE.SpriteMaterial).color.setRGB(r, g, b);

      // THE LEVEL, CENTRED IN THE ART'S OWN SLOT -- the filled brass cell at texels 106..127. The first
      // version printed it floating outside the bar's right edge, which was the owner's second point.
      const levelText = unit.level > 0 ? String(unit.level) : '';
      if (levelText !== plate.builtLevel) {
        plate.builtLevel = levelText;
        this.stats.rasterized += 1;
        this.setText(plate.level, levelText, plateFont(PLATE.levelSize, '#ffffff'), unitScale);
      }
      plate.level.visible = levelText !== '';
      if (plate.level.visible) {
        // THE LEVEL NUMBER'S COLOUR IS THE CLIENT'S OWN DIFFICULTY RAMP, reached through the client's own
        // `GetQuestDifficultyColor` rather than a copy of it -- see `NameplateConfig.levelColor`. On the
        // material, so a level or a player level changing costs no re-rasterize.
        (plate.level.material as THREE.SpriteMaterial).color.setRGB(
          levelTint[0], levelTint[1], levelTint[2],
        );
        const levelW = plate.level.scale.x;
        const levelH = plate.level.scale.y;
        const slotCentre = (ART.slotLeft + ART.slotWidth / 2 - ART.frameWidth / 2) * unitScale;
        plate.level.center.set(
          0.5 - slotCentre / levelW,
          -(lift + (frameH - levelH) / 2) / levelH,
        );
      }
    } else {
      plate.barBack.visible = false;
      plate.barFill.visible = false;
      plate.border.visible = false;
      plate.level.visible = false;
      plate.fraction = null;
    }

    plate.name.visible = nameSize.x > 0 && label !== '';
    // The name sits above the bar when there is one, and on the anchor when there is not.
    const nameBottom = lift + (bar ? frameH + PLATE.nameGap * unitScale : 0);
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
    // ORDER IS DRAW ORDER within the plate (`renderOrder`, set per sprite): the depleted backing, the
    // fill over it, then the AUTHORED FRAME over both -- the frame's border has to cover the fill's hard
    // edge, which is what stops the plate reading as a flat rectangle.
    const barBack = this.sprite({ alpha: 0.7, rgb: [0.06, 0.06, 0.06], order: 0 });
    const barFill = this.sprite({ alpha: 1, rgb: [1, 1, 1], order: 1, texture: BAR_TEXTURE });
    const border = this.sprite({ alpha: 1, rgb: [1, 1, 1], order: 2, texture: BORDER_TEXTURE });
    const name = this.sprite({ alpha: 1, rgb: [1, 1, 1], order: 3, text: true });
    const level = this.sprite({ alpha: 1, rgb: [1, 1, 1], order: 4, text: true });
    group.add(barBack, barFill, border, name, level);
    this.group.add(group);
    const plate: Plate = {
      group, name, level, barBack, barFill, border,
      builtName: NEVER_BUILT, builtLevel: NEVER_BUILT, seen: true, fraction: null,
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
  private sprite(spec: {
    alpha: number;
    rgb: [number, number, number];
    /** Draw order WITHIN the plate -- the frame must land over the fill's hard edge. */
    order: number;
    /** An authored sheet to load, for the frame and the bar shading. */
    texture?: string;
    /** A sprite whose map is a rasterized string, filled in by `setText`. */
    text?: boolean;
  }): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      map: spec.texture !== undefined
        ? this.artTexture(spec.texture)
        : (spec.text === true ? null : this.solidTexture()),
      color: new THREE.Color(spec.rgb[0], spec.rgb[1], spec.rgb[2]),
      transparent: true,
      opacity: spec.alpha,
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.frustumCulled = false;
    // After the ordinary transparents. The reference biases its name batch to the top rung of its own
    // sort ladder for the same reason (`NAMEPLATE_DEPTH_BIAS`, `nameplates.rs:79-88`): world text that
    // sorts under a water surface is text nobody can read. `+ order` resolves the PLATE'S OWN stack:
    // three breaks equal `renderOrder` by depth, and every sprite in a plate is at the SAME depth, so
    // without it the frame and the fill would sort by insertion accident.
    sprite.renderOrder = 10000 + spec.order;
    return sprite;
  }

  /** The two authored sheets, keyed by path. Null until the BLP lands; the sprite then draws nothing. */
  private readonly art = new Map<string, THREE.Texture | null>();

  /**
   * One authored sheet, loading it on first ask.
   *
   * **CLONED, and FLIPPED WITH A NEGATIVE `repeat.y` -- NOT with `flipY`.** Both sheets are DXT
   * (`nameplate-border` DXT3, `ui-statusbar` DXT1), and **`flipY` does not apply to a compressed
   * upload** -- which is the reason `texture-loader.js` sets `flipY = false` on everything in the first
   * place. `THREE.Sprite`'s built-in geometry runs `v = 0` at the quad's BOTTOM, so a `flipY = false`
   * sheet lands mirrored.
   *
   * The first version set `flipY = true` and read the sub-rect as `offset.y = 0, repeat.y = 17/32`. The
   * flip was silently ignored, so that span selected the file's **first** 17 rows -- which are the
   * entirely EMPTY ones (see `ART`) -- and the frame drew nothing at all while every other part of the
   * plate looked right. `offset.y = 1` with a NEGATIVE `repeat.y` does the flip through the UV transform
   * instead, which works for compressed and uncompressed alike: the quad's bottom samples the file's last
   * row and its top samples row 15.
   *
   * A clone rather than a mutation of the shared texture: nothing else in this client asks for these two
   * paths today, but a future caller that did would get a silently upside-down sheet with a sub-rect it
   * never asked for, and this file must not be the reason.
   */
  private artTexture(path: string): THREE.Texture | null {
    const known = this.art.get(path);
    if (known !== undefined) {
      return known;
    }
    this.art.set(path, null);
    TextureLoader.load(
      path,
      // `as any`: `texture-loader.js` is untyped JS whose default parameter narrows the inferred type to
      // `RepeatWrapping` alone -- the cast `game/ui/art.ts:103-107` makes for the same reason.
      THREE.ClampToEdgeWrapping as any,
      THREE.ClampToEdgeWrapping as any,
      PRIORITY.CHARACTER,
    )
      .then((texture: THREE.Texture) => {
        const own = texture.clone();
        // Explicitly false, matching the loader's uniform choice, so the orientation is decided in ONE
        // place -- the UV transform below -- whatever three does or does not do with the flag.
        own.flipY = false;
        const span = path === BORDER_TEXTURE ? ART.frameHeight / ART.fileHeight : 1;
        own.offset.set(0, 1);
        own.repeat.set(1, -span);
        own.needsUpdate = true;
        this.art.set(path, own);
        // Retro-fit the sheet onto every plate already built while it was in flight.
        this.plates.forEach((plate) => {
          const sprite = path === BORDER_TEXTURE ? plate.border : plate.barFill;
          const material = sprite.material as THREE.SpriteMaterial;
          material.map = own;
          material.needsUpdate = true;
        });
      })
      .catch(() => {
        // Both paths were probed at 200 before this was written. A miss leaves the sprite mapless, which
        // draws NOTHING -- visibly incomplete rather than a hand-drawn substitute for the authored art.
      });
    return null;
  }

  /**
   * The level number's colour: the client's own difficulty ramp, memoized.
   *
   * Goes through `config.levelColor`, i.e. the client's own `GetQuestDifficultyColor` -- see that field
   * for the authored ramp and for why `targetframe.lua:246-251` makes it the right call rather than a
   * plausible one. Memoized on `level:playerLevel` because crossing the VM per plate per frame would be
   * the opposite of what the owner asked for; the key includes the PLAYER'S level because the ramp is a
   * difference and the cache would otherwise survive a level-up.
   *
   * The fallback is `targetframe.lua:249`'s own `else` branch value, `(1.0, 0.82, 0.0)` -- what the client
   * uses for a unit it will not difficulty-colour. Reached only before the runtime is up.
   */
  private readonly levelTints = new Map<string, [number, number, number]>();

  private levelTint(unit: Unit, config: NameplateConfig): [number, number, number] {
    const mine = this.selfLevel;
    const key = `${unit.level}:${mine}`;
    const cached = this.levelTints.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const answered = config.levelColor === null ? null : config.levelColor(unit.level);
    const tint: [number, number, number] = answered ?? [1.0, 0.82, 0.0];
    // Only cached once the runtime has actually answered -- caching the fallback would freeze every
    // plate on it for the session.
    if (answered !== null) {
      this.levelTints.set(key, tint);
    }
    return tint;
  }

  /** The local player's level, as of this pass -- the ramp's other operand. See `levelTint`. */
  private selfLevel = 0;

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
