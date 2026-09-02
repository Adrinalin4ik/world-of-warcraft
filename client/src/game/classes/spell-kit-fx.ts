/**
 * THE EMITTER SLOTS of a spell visual kit: which M2 attachment each of a kit's slots hangs its effect
 * model on. Resolution only -- **nothing here draws.**
 *
 * A `SpellVisualKit` row carries eleven `SpellVisualEffectName` slots plus a twelfth world-plant slot
 * (`dbc/entities/spell-visual-kit.js` carries the column measurement). Each attach slot's tag is a
 * **direct M2 `AttachmentID`**, a compile-time immediate in the client's own slot loop -- not a DBC
 * column, which is why the tags come from the reference and had to be re-measured here rather than
 * read out of a file.
 *
 * ## The tags, and what agreed with the reference
 *
 * `samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs:104-108` gives NINE tags for its
 * nine 1.12 slots: `KIT_SLOT_TAGS = [0x14, 0x22, 0x13, 0x15, 0x16, 0x11, 0x17, 0x18, 0x19]` =
 * Head, Chest, Base, LeftHand, RightHand, Breath, Special1-3.
 *
 * Checked two ways on this build, both static.
 *
 * **1. Against 23 real served M2 models**, decoded through this client's own parser
 * (`harness/attach-probe.test.js` is the instrument: 9 character race/gender rigs -- human m/f, orc,
 * night elf, scourge, gnome, dwarf, draenei, blood elf -- and 14 creatures including Illidan,
 * Kel'Thuzad, the Lich King, a dragon, an infernal, a wolf, a murloc, a kobold):
 *
 *     tag            id   present     what the position says
 *     0x14 Head      20   23 / 23     the highest z on every rig (human male 2.0272, night elf 2.4444)
 *     0x22 Chest     34   23 / 23     mid-torso z (human male 1.4307 on a 2.03-tall body)
 *     0x13 Base      19   23 / 23     the model origin, i.e. the feet -- see below for how exactly
 *     0x15 LeftHand  21   23 / 23     +Y on all 23
 *     0x16 RightHand 22   23 / 23     -Y on all 23
 *     0x11 Breath    17   23 / 23     the largest +X at head height -- the mouth (wolf 1.3862 forward)
 *     0x17 Special1  23    2 / 23     draenei male [0, 0, 2.5408] (over the head); dragon [7.72, 0, 7.78]
 *     0x18 Special2  24    0 / 23     absent everywhere probed
 *     0x19 Special3  25    0 / 23     absent everywhere probed
 *
 * Six of the nine are unanimous. `Base` sitting at the model ORIGIN is the single strongest agreement
 * in the set -- no other attachment id in any of these files is anywhere near it.
 *
 * How exactly, because a first draft of this comment said "exactly [0,0,0] on all 23" and the probe's
 * own assertion proved that false: **22 of the 23 carry exact zeros** on all three axes (several as
 * IEEE negative zero, which is numerically 0 and bit-level 0x80000000), and `draeneimale.m2` carries
 * `z = 1.3209e-4`. So the true claim is "the origin to within a tenth of a millimetre on a 2.2-yard
 * body", which is still four orders of magnitude below the nearest real attachment offset, and the
 * probe asserts a 1e-3 tolerance rather than equality.
 *
 * **The left/right naming agreed too, and that was NOT taken on trust.**
 * `ui/scene/character-attachments.ts` had already measured this build's own sign convention from its
 * own `HumanMale.m2` dump -- the drawn mainhand (id 1) sits at -Y and the drawn offhand (id 2) at +Y,
 * so negative Y is the character's RIGHT. Here 0x15 is +Y and 0x16 is -Y on all 23 models, which is
 * exactly the reference's LeftHand / RightHand assignment. A swap would have put every hand effect on
 * the wrong hand with nothing to say so.
 *
 * **2. Against `SpellVisualKitModelAttach.dbc`**, a table that does not exist in 1.12 and so is
 * independent of the reference entirely. Its own `attachmentID` column, over 591 rows:
 *
 *     19 Base x236 | 34 Chest x103 | -1 x81 | 22 RightHand x51 | 17 Breath x41 | 21 LeftHand x24
 *     | 20 Head x7 | 23 Special1 x5 | ... 43 further rows spread over 13 other ids
 *
 * **467 of 591 rows (79.0%) name one of the reference's nine**, and the six most-used ids in the table
 * are precisely the six that are unanimous on the models. The 81 rows at `-1` match the reference's
 * own world-plant sentinel convention. That a 3.3.5a-only table concentrates on the 1.12 client's
 * hardcoded immediates is about as good as corroboration gets here without a disassembler.
 *
 * **What did NOT agree:** Special2 (0x18) and Special3 (0x19) appear on none of the 23 models AND on
 * none of the 591 DBC rows. Special1 (0x17) appears on 2 models and 5 DBC rows. So the reference's
 * three special tags are not contradicted, but only one of them is positively confirmed here. They are
 * kept as the reference gives them, and `attachmentLookups` is what makes that safe -- a model without
 * the point resolves to nothing rather than to the wrong bone (see `TAG_ABSENT_IS_NORMAL`).
 *
 * ## `SpellVisualKitModelAttach` is ADDITIVE, not an override -- and the data says which
 *
 * The table carries an explicit attach id plus an offset and a yaw/pitch/roll, none of which the inline
 * slot path can express (the inline placement is bone + zero offset + no rotation of its own). 379 of
 * its 591 rows (64.1%) carry a non-zero offset or rotation, so most of what it holds is placement the
 * inline slots could not state at all.
 *
 * It overlaps the inline slots on only **12 of its 431 (kit, effect) pairs**, so 419 are additive by
 * construction -- there is no inline slot for them to override. For the 12 that do collide, the numbers
 * settle it, because in every multi-row case the table's values are exactly the members of a REGULAR
 * SERIES whose only missing member is what the inline slot draws:
 *
 *     kit 12785 effect 5492 attach 19   yaws 90, 180, 270 deg      + the inline 0 deg -> 0/90/180/270
 *     kit 14555 effect 6560 attach 19   offset z 1.0, 2.0          + the inline 0.0   -> 0.0/1.0/2.0
 *     kit 13576 effect 621  attach 34   offset z -0.25, +0.25      + the inline 0.0   -> a symmetric triple
 *     kit 13705 effect 4545 attach 19   offset z 0.5, 0.75         + the inline 0.0
 *
 * Read as an OVERRIDE, kit 12785 is a three-quarter fan with a hole at 0 degrees and kit 14555 is a
 * ladder missing its bottom rung -- neither of which an artist authors. Read as ADDITIVE, both are
 * complete and regular. So the inline slot supplies the un-offset, un-rotated instance and the table
 * adds the rest; **neither wins, because they are not alternatives.**
 *
 * This is a data argument, not a byte-level one: the reference cannot help (the table postdates it) and
 * nothing here disassembles the 3.3.5a client. It is recorded as the reading the numbers support, and
 * the falsifier is stated above so a later capture can overturn it. Nothing consumes the table yet --
 * this module resolves the inline slots only.
 */
import { spellData } from '../pipeline/dbc/spell-data';
import { warnOnce } from '../ui/framexml/lua/methods/region';

/**
 * A slot with no known attachment tag. See `KIT_SLOT_TAGS` -- two of this build's eleven slots are in
 * this state and are refused rather than guessed.
 */
export const TAG_UNKNOWN = null;

/**
 * The world-plant sentinel: no bone at all. The reference's `WORLD_EFFECT_TAG`
 * (`spell_visual/mod.rs:110-120`), which is the client's own `-1` -- the placement walk skips the whole
 * bone pipeline and plants the model once at the owner's position, facing and scale.
 *
 * Corroborated on this build by `SpellVisualKitModelAttach` carrying `-1` in its own attach column on
 * 81 of 591 rows, i.e. the same convention in a table the reference never saw.
 */
export const WORLD_EFFECT_TAG = -1;

/**
 * THE ELEVEN SLOTS' M2 attachment tags, in kit-field order, `null` where this build's tag is unknown.
 *
 * Indices 0-5 and 8-10 are the reference's nine, re-measured -- see the file header for the 23-model
 * and 591-row checks. Indices **6 and 7 are the two slots 3.3.5a adds** and their tags are NOT known:
 * see `UNTAGGED_SLOTS`.
 *
 * Which of the hand pair is the left is the reference's field order, not a measurement here: the tags
 * themselves are measured (0x15 is +Y, 0x16 is -Y on all 23 models), and columns 3-5 and 8-10 align
 * with the reference's field order exactly, so the pair at 3/4 aligning too is the reading that needs
 * no extra assumption. A swap inside the pair would mirror hand effects and nothing else.
 */
export const KIT_SLOT_TAGS: ReadonlyArray<number | null> = [
  0x14, // 0  head      -- 23/23 models, the highest z
  0x22, // 1  chest     -- 23/23 models, mid-torso
  0x13, // 2  base      -- 23/23 models, exactly [0,0,0]
  0x15, // 3  hand A    -- 23/23 models, +Y (the reference's LeftHand)
  0x16, // 4  hand B    -- 23/23 models, -Y (the reference's RightHand)
  0x11, // 5  breath    -- 23/23 models, forward at head height
  TAG_UNKNOWN, // 6  weapon A -- 3.3.5a addition, tag unknown
  TAG_UNKNOWN, // 7  weapon B -- 3.3.5a addition, tag unknown
  0x17, // 8  special1  -- 2/23 models, 5/591 DBC rows
  0x18, // 9  special2  -- 0/23 models, 0/591 DBC rows; the reference's value, unconfirmed here
  0x19, // 10 special3  -- 0/23 models, 0/591 DBC rows; the reference's value, unconfirmed here
];

/**
 * The two slots this client refuses to place, and why refusing beats guessing.
 *
 * 3.3.5a's kit has ELEVEN emitter slots where 1.12 has nine, and the two extra sit between the breath
 * slot and the special triple. `dbc/entities/spell-visual-kit.js` evidences WHAT they hold -- they are
 * the only slot columns whose contents are HELD OBJECTS rather than body VFX
 * (`SpellObject_Wrench.mdx`, `TankardA_SpellObject.mdx`, `TorchSpell.mdx`, and eight rows each of
 * `firearm_2h_rifle_a_06.mdx` and `firearm_2h_rifle_01_spellobject.mdx`) -- which is why they read as
 * a weapon pair. **It does not evidence WHICH attachment id they hang on.**
 *
 * The reference cannot say either: it has nine slots and nine tags, so it has no opinion about these
 * two. And `SpellVisualKitModelAttach` does not pin them -- none of its 431 (kit, effect) pairs matches
 * a slot-6 or slot-7 entry, so the table never re-states one of these placements with an explicit id.
 *
 * A guess here would be quiet and wrong in a specific way. The plausible candidates -- 1 and 2, the
 * DRAWN mainhand and offhand measured in `ui/scene/character-attachments.ts` -- are real attachment
 * ids present on every character rig, so a guessed tag would resolve, parent successfully, and hang a
 * rifle on a bone nobody verified, with nothing anywhere saying it was a guess. That is exactly the
 * "renders plausibly and wrongly" failure `CLAUDE.md` names.
 *
 * So `kitEmitters` skips them and `warnOnce`s. **This is the `notImplemented` PRINCIPLE rather than
 * that factory**: `notImplemented` returns a Lua `FrameMethod` and surfaces through the XML loader's
 * report, and this is a data path with no widget and no document to report against. The same guarantee
 * is met the way this subsystem already reports -- a one-shot console warning naming the slot, the kit
 * and the effect, plus the slot counts in the `spellWire` load record -- so the gap is named where the
 * spell subsystem's other facts already are, and it is never a silent no-op.
 */
export const UNTAGGED_SLOTS: ReadonlyArray<number> = [6, 7];

/**
 * A model legitimately not having a slot's attachment point is a NORMAL outcome, not a gap.
 *
 * Measured: six of the nine known tags exist on all 23 models probed, but Special1 exists on 2 and
 * Special2/Special3 on none. So a kit that fills its special slots resolves to nothing on a human and
 * to something on a dragon, and that is the data being rig-specific rather than anything being broken.
 *
 * `M2#attachTo` is where this is enforced and it already returns `false` for an id the model does not
 * carry (`pipeline/m2/index.ts:1220-1238`: it looks the record up and bails before touching a bone).
 * So this module resolves tags and hands them over -- it must NOT pre-filter per model, because it does
 * not know which model the kit will play on.
 */
export const TAG_ABSENT_IS_NORMAL = true;

/** The slot index reported for the world-plant effect, which is not one of the eleven. */
export const WORLD_SLOT = -1;

/** One resolved emitter: which slot, which attachment tag, which effect, and its model path. */
export interface KitEmitter {
  /** The kit-field slot index 0-10, or `WORLD_SLOT` for the world plant. */
  slot: number;
  /** The M2 `AttachmentID` to parent on, or `WORLD_EFFECT_TAG` for the world plant. */
  tag: number;
  /** The `SpellVisualEffectName` id. */
  effectId: number;
  /** The model path as the DBC spells it -- `M2Blueprint.load` rewrites the extension. */
  modelPath: string;
}

/**
 * A kit's emitters, resolved to (attachment tag, effect id, model path).
 *
 * **Every populated slot fires at EVERY stage** -- the stage sets lifetime policy only, not which slots
 * run (`spell_visual/mod.rs:23-27`). So this takes a kit and not a stage.
 *
 * The world plant comes LAST and under `WORLD_EFFECT_TAG`, which is the reference's own ordering
 * (`VisualKit::effects`): the bone slots in field order, then the world slot.
 *
 * A slot whose model path does not resolve is DROPPED rather than substituted, and that asymmetry with
 * the missile path is deliberate: the reference's `Spells\ErrorCube.mdx` is specifically the MISSILE
 * fallback (`creature_anim/spell_visual.rs:952-957`) and says nothing about kit slots, so borrowing it
 * here would be inventing a rule the reference does not state.
 */
export function kitEmitters(kitId: number): KitEmitter[] {
  const slots = spellData.kitEffectSlots(kitId);
  const out: KitEmitter[] = [];

  if (slots !== null) {
    for (let slot = 0; slot < slots.length; slot += 1) {
      const effectId = slots[slot];
      if (effectId === null) {
        continue;
      }
      const tag = KIT_SLOT_TAGS[slot];
      if (tag === TAG_UNKNOWN) {
        // NAMED, never silent -- see `UNTAGGED_SLOTS` for why a guess would be worse than a refusal.
        warnOnce(
          `SpellVisualKit slot ${slot}: no attachment tag is established for this build's two extra `
          + `emitter slots, so effect ${effectId} on kit ${kitId} is not placed. The reference has `
          + 'nine slots and nine tags; 3.3.5a has eleven.',
        );
        continue;
      }
      const modelPath = spellData.effectModelPath(effectId);
      if (modelPath !== null) {
        out.push({
          slot, tag, effectId, modelPath,
        });
      }
    }
  }

  const world = spellData.kitWorldEffect(kitId);
  if (world !== null) {
    const modelPath = spellData.effectModelPath(world);
    if (modelPath !== null) {
      out.push({
        slot: WORLD_SLOT, tag: WORLD_EFFECT_TAG, effectId: world, modelPath,
      });
    }
  }

  return out;
}
