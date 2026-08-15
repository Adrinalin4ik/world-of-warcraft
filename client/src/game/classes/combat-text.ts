/**
 * THE COMBAT-TEXT LAW: what one completed swing says, in words or in a number, and how that text
 * lives and dies.
 *
 * The owner asked for both media -- "По цифрам оба варианта" -- and for the outcomes to be visible,
 * "Не забудь про анимацию параирований и промахов и доджей". This file is the half both media share:
 * `SMSG_ATTACKERSTATEUPDATE`'s `HitInfo` and `VictimState` turned into a decision. Two consumers read
 * it and they are on OPPOSITE sides of the engine/Lua division, deliberately:
 *
 *  - **`world/floating-text.ts`** -- the big engine-drawn number over the victim's head. World-pass
 *    geometry, the same side `world/nameplates.ts`, `world/selection-ring.ts` and `drawSweeps` are on.
 *  - **`ui/unit-bridge.ts`** -- the `UNIT_COMBAT` event, which the CLIENT'S OWN LUA turns into the
 *    hit indicator on the player's portrait (`combatfeedback.lua`). Nothing is drawn by us there; the
 *    fade timings, the font sizes and the colour table are all the client's own.
 *
 * ## `HitInfo` IS VERSION-NUMBERED, AND THIS IS THE SHARP CASE
 *
 * The reference's melee emitter (`samples/benilla/crates/benilla/src/combat_text/law.rs:155-179`,
 * byte-verified against the client's own `0x6243e0`) reads bit **`0x80` as `HITINFO_CRITICALHIT`**.
 * That is 1.12.1. On **3.3.5a `0x80` is `HITINFO_FULL_RESIST`** and the crit bit is **`0x200`** -- so
 * taking the reference's number would print a resist as a crit and a crit as an ordinary hit. This
 * file takes the MECHANISM from the reference (which branch runs in which order, what the categories
 * are, how the fade ramps) and the NUMBERS from 3.3.5a, exactly as `CLAUDE.md` requires.
 *
 * **WHERE THE 3.3.5a NUMBERS COME FROM, stated plainly: a SERVER IMPLEMENTATION.** They are
 * TrinityCore's `enum HitInfo` (`src/server/game/Entities/Unit/Unit.h`, the 3.3.5 branch) -- the same
 * class of source as the NPC service-flag bits and `CMSG_SET_ACTION_BUTTON`'s `u8` slot prefix, both
 * of which are labelled the same way. **Nothing in the game's own data states them**: no DBC carries
 * them and the client's own Lua never sees `HitInfo` (`CombatFeedback_OnCombatEvent` is handed
 * already-decoded STRINGS -- `"CRITICAL"`, `"GLANCING"`, `"CRUSHING"` -- so FrameXML cannot corroborate
 * a bit value). Two of them were ALREADY in this client with no source line at all
 * (`network/game/object/combat.ts`'s absorb and resist masks, which decide a byte count); they are
 * imported from here now so there is one table.
 *
 * The two masks that were already here are also the reason the set can be checked rather than
 * believed: they gate whether a trailing loop is on the wire at all, and `handleAttackerState`
 * validates its own decode against `bodySize`. A wrong absorb or resist bit desyncs the packet and is
 * reported. `0x200` cannot be checked that way, so it is checked LIVE instead --
 * `window.combatWire.census()` groups every observed `hitInfo` against the damage those swings did, and a
 * crit is the group whose mean is about twice the ordinary one. It reports `0x200` and the reference's
 * `0x80` side by side so the two readings are compared against the damage rather than argued about.
 */

/**
 * 3.3.5a `HitInfo`. SOURCE: TrinityCore `Unit.h` `enum HitInfo` (3.3.5 branch) -- a SERVER
 * implementation, see the header. Only the bits something here reads are listed; naming a bit we do
 * not act on would be a table nobody checks.
 */
export const HIT_INFO = {
  /** An offhand swing. Read by `swingAnimation`'s caller. */
  OFFHAND: 0x4,
  /**
   * `HITINFO_MISS`. Present for the sake of the note in `meleeText`: the reference's emitter NEVER
   * tests it, and a miss reaches its word through the zero-damage default instead. So its value is
   * never load-bearing here, which is one fewer server-sourced bit the display rests on.
   */
  MISS: 0x10,
  FULL_ABSORB: 0x20,
  PARTIAL_ABSORB: 0x40,
  FULL_RESIST: 0x80,
  PARTIAL_RESIST: 0x100,
  /**
   * **NOT `0x80`.** The whole reason this file states its version; see the header.
   *
   * **CORROBORATED LIVE** (`scratchpad/t24-damage.js`, a real fight with a Volatile Mutation, our own
   * swings only): ordinary swings arrive as `hitInfo 0x2` and land 2 damage repeatedly; the one swing
   * that arrived as `0x202` landed **4** -- exactly double -- and no `0x80` swing carried damage at all.
   * A single crit proves nothing on its own, which is why `combatWire.census()` groups by word and
   * reports the `0x200` and `0x80` readings side by side against the damage.
   */
  CRITICALHIT: 0x200,
  /** Suppresses the swing animation entirely. Pre-existing in this client; see `DISPUTED` below. */
  NO_ANIMATION: 0x10000,
} as const;

/**
 * THE BITS ABOVE `0x200` ARE DISPUTED, AND NOTHING HERE READS THEM.
 *
 * Two published versions of "the 3.3.5a `HitInfo` enum" exist and they **disagree from `0x800` upward**:
 * one places `BLOCK 0x800`, `GLANCING 0x4000`, `CRUSHING 0x8000`, `NO_ANIMATION 0x10000`; the other
 * places `BLOCK 0x2000`, `GLANCING 0x8000`, `CRUSHING 0x10000`, `NO_ANIMATION 0x20000`. Both are server
 * implementations, so neither outranks the other on authority.
 *
 * **THE WIRE REFUTES AT LEAST ONE OF THEM**, measured here rather than argued: in the fight above, every
 * swing arrived with `bodySize` 44 except two, which carried `hitInfo 0x2002` and `bodySize` **48** --
 * four bytes longer. `SMSG_ATTACKERSTATEUPDATE`'s only trailing CONDITIONAL words are `BlockedAmount`
 * and the rage word, so bit `0x2000` gates one of them; the attacker was a creature and the victim a
 * shaman, which makes a rage word implausible. That is the SECOND variant's `HITINFO_BLOCK`.
 *
 * So the display reads **none of them**, and this is a declared gap rather than a silent no-op:
 *
 *  - `combatFeedbackArgs` never emits `"GLANCING"` or `"CRUSHING"`. The consequence is bounded and
 *    stated: the client's own `CombatFeedback_OnCombatEvent` would scale the portrait number to 1.5x for
 *    a crushing blow and 0.75x for a glancing one (`combatfeedback.lua:44-48`), so those two land at the
 *    ordinary size. A crit still scales, because `0x200` is verified.
 *  - `meleeText` never reads a block bit. It does not need one: the reference's emitter takes BLOCK off
 *    `VictimState == 5` (`law.rs:159`), which is not version-numbered.
 *  - `NO_ANIMATION 0x10000` is left exactly as this client already had it, UNCHANGED and unverified. If
 *    the second variant is the right one then that value is `CRUSHING` and a crushing blow currently
 *    suppresses its own swing animation. That is a real open risk, it is not this round's subject, and
 *    changing it on a coin-flip would be worse than naming it.
 *
 * Settling it needs a swing that carries one of these bits observed against a known outcome -- a shield
 * block, or a level gap wide enough to force a crushing blow. Northshire at level 2 produces neither.
 */
export const DISPUTED_HIT_INFO_NOTE = 'see the DISPUTED comment in classes/combat-text.ts';

/** Both trailing per-sub loops are present only when their pair of bits is carried. */
export const HIT_INFO_ANY_ABSORB = HIT_INFO.FULL_ABSORB | HIT_INFO.PARTIAL_ABSORB;
export const HIT_INFO_ANY_RESIST = HIT_INFO.FULL_RESIST | HIT_INFO.PARTIAL_RESIST;

/**
 * `VictimState`, the outcome word. The values are `combat-anim.ts`'s -- cross-checked there against
 * the reference's own three independent uses (the combat-text picker `combat_text/law.rs:149-156`, the
 * defense-anim table `select.rs:587-603` and the blood gate `blood.rs:83-84`) -- and this numbering is
 * NOT version-dependent the way a `HitInfo` bit is. Duplicated as a local table rather than exported
 * from there because that file's copy is private and the two uses are genuinely different questions.
 */
const VICTIM = {
  MISS: 0, HIT: 1, DODGE: 2, PARRY: 3, INTERRUPT: 4, BLOCK: 5, EVADE: 6, IMMUNE: 7, DEFLECT: 8,
} as const;

/**
 * `SchoolMask` -- the first word of each sub-damage block. `combatfeedback.lua:5-12` declares the whole
 * set in the CLIENT'S OWN LUA, which is why this one needs no server source:
 * `SCHOOL_MASK_PHYSICAL = 0x01`. It is the only value either medium tests: the client's own
 * `CombatFeedback_OnCombatEvent` turns a non-physical wound YELLOW (`combatfeedback.lua:50-54`).
 */
export const SCHOOL_MASK_PHYSICAL = 0x01;

/**
 * One config-table row -- `law.rs:10-18`, the reference's byte-verified `0xce8828` (stride 0x1c,
 * filled by `0x6c79a0`): the rise over the full life in WORLD units, the fade-in end / fade-out start /
 * duration in ms, the scale pair, and the packed default colour.
 */
export interface Category {
  rise: number;
  fadeInMs: number;
  fadeOutMs: number;
  durMs: number;
  valueLo: number;
  valueHi: number;
  /** ARGB, client-packed. The alpha byte is discarded -- the fade replaces it (`law.rs:305-316`). */
  color: number;
}

/**
 * The category scale values, bit-exact off the reference (`law.rs:20-22`): `0.018333` is
 * `0x3c962fc9` and `0.0275` is `0x3ce147ad`. A settled crit is exactly 1.5x a normal number.
 */
const VALUE_NORMAL = 0.018333;
const VALUE_CRIT = 0.0275;

/**
 * The six rows, `law.rs:27-82`. 0 normal number · 1 ABSORB word · 2 crit number · 3
 * miss/dodge/parry/block word · 4 XP · 5 honor.
 *
 * Row 1's `fadeOut 90 < fadeIn 150` is real and the reference says so -- a quick flicker, not a decode
 * slip, and it means that row has no plateau at all. Rows 4 and 5 are the slow coloured 4.5 s texts and
 * are carried here rather than trimmed because they are part of the verified table; **nothing in this
 * client emits them yet** (there is no xp-gain or honor feed on this path) and that is a gap, not a
 * silent no-op -- no code selects rows 4 or 5.
 */
export const CATEGORIES: readonly Category[] = [
  { rise: 2.0, fadeInMs: 150, fadeOutMs: 760, durMs: 1500, valueLo: VALUE_NORMAL, valueHi: VALUE_NORMAL, color: 0xffffffff },
  { rise: 2.0, fadeInMs: 150, fadeOutMs: 90, durMs: 1500, valueLo: VALUE_NORMAL, valueHi: VALUE_NORMAL, color: 0xffffffff },
  { rise: 0.0, fadeInMs: 150, fadeOutMs: 1000, durMs: 1500, valueLo: 0, valueHi: VALUE_CRIT, color: 0xffffffff },
  { rise: 2.0, fadeInMs: 150, fadeOutMs: 1000, durMs: 1500, valueLo: VALUE_NORMAL, valueHi: VALUE_NORMAL, color: 0xffffffff },
  { rise: 0.0, fadeInMs: 500, fadeOutMs: 2000, durMs: 4500, valueLo: VALUE_NORMAL, valueHi: VALUE_NORMAL, color: 0x8094008b },
  { rise: 0.0, fadeInMs: 500, fadeOutMs: 2000, durMs: 4500, valueLo: VALUE_NORMAL, valueHi: VALUE_NORMAL, color: 0xffe0ca0a },
];

export const CATEGORY_NUMBER = 0;
export const CATEGORY_ABSORB = 1;
export const CATEGORY_CRIT = 2;
export const CATEGORY_WORD = 3;

/**
 * The crit "pop" keyframes -- `law.rs:87-91`, the reference's `0x8112dc`, gated on category 2. Three
 * segments `{t0, t1, s0, s1}` whose interpolated factor multiplies `valueHi`: pop to 2x within the
 * first 10% of life, settle to 1x by 20%.
 */
const CRIT_KEYFRAMES: readonly [number, number, number, number][] = [
  [0.0, 0.1, 0.1, 2.0],
  [0.1, 0.2, 2.0, 1.0],
  [0.2, 1.0, 1.0, 1.0],
];

/**
 * The CLIENT'S OWN key for each outcome word -- the keys of `CombatFeedbackText`
 * (`combatfeedback.lua:15-26`), which is the client's own table mapping exactly these names to the
 * localized `GlobalStrings.lua` values (`MISS`, `DODGE`, `PARRY`, ...).
 *
 * **Keys, not strings.** The reference hardcodes the shipped enUS words (`law.rs:97-100`, "hardcoded
 * like the rest of our enUS-only data") because it has no FrameXML; this client loads the real
 * `GlobalStrings.lua`, so the actual text is read out of the client's own globals through a door (see
 * `world/floating-text.ts#WordSource`) and there is ONE copy of it -- the same argument the nameplate's
 * level colour is reached through `GetQuestDifficultyColor` rather than transcribed.
 *
 * Indexed by the reference's own outcome code 1..11 (`law.rs:93-100`, the client's `0x86582c` key table,
 * which is bit-for-bit vmangos' `SpellMissInfo`). Code 7 and 8 are both IMMUNE there, as shipped.
 */
const WORD_KEY: readonly string[] = [
  'MISS', 'RESIST', 'DODGE', 'PARRY', 'BLOCK', 'EVADE', 'IMMUNE', 'IMMUNE', 'DEFLECT', 'ABSORB',
  'REFLECT',
];

/** Outcome code 1..11 -> `(key, category)`. Category 3 for every word except ABSORB, which is 1 (`law.rs:104-107`). */
function missWord(code: number): { key: string; category: number } | null {
  const key = WORD_KEY[code - 1];
  if (key === undefined) {
    return null;
  }
  return { key, category: code === 10 ? CATEGORY_ABSORB : CATEGORY_WORD };
}

/** What one swing floats: either a number, or a word to be looked up in the client's own table. */
export interface MeleeText {
  category: number;
  /** The already-formatted number, when this is a number. */
  number: string | null;
  /** The `CombatFeedbackText` key, when this is a word. */
  wordKey: string | null;
}

/**
 * THE MELEE EMITTER SPLIT -- `law.rs:155-179`, i.e. `0x6243e0`'s branch order, byte-verified there
 * (decision 0279). Branch order is the reference's; every BIT is 3.3.5a's (see the header).
 *
 * A **word state** -- dodge, parry, block, evade, immune, deflect -- floats its word
 * UNCONDITIONALLY and `Damage` is ignored, which is why a partial block shows "Block" and not a
 * number. Otherwise (states 0 UNAFFECTED / 1 NORMAL / 4 INTERRUPT, the silent NORMAL alias) landed
 * damage floats the bare post-mitigation number, category 2 on a crit and 0 otherwise -- an absorb or
 * a partial resist is never annotated -- and ZERO damage falls to full-absorb -> "Absorb",
 * full-resist -> "Resist", else the "Miss" word.
 *
 * **The function never tests `HITINFO_MISS`**, and that is the reference's finding rather than an
 * omission of ours: a miss against zero damage reaches its word through the default arm. So `0x10`'s
 * value is never load-bearing, which is one less server-sourced bit the display depends on.
 *
 * `victimState` may be `null` -- `handleAttackerState` reports that as a decode that did not add up --
 * and a null outcome floats NOTHING rather than guessing at the common case.
 */
export function meleeText(
  hitInfo: number,
  victimState: number | null,
  damage: number,
): MeleeText | null {
  if (victimState === null) {
    return null;
  }
  let code: number;
  switch (victimState) {
    case VICTIM.DODGE: code = 3; break;
    case VICTIM.PARRY: code = 4; break;
    case VICTIM.BLOCK: code = 5; break;
    case VICTIM.EVADE: code = 6; break;
    case VICTIM.IMMUNE: code = 7; break;
    case VICTIM.DEFLECT: code = 9; break;
    default: {
      if (damage > 0) {
        const category = (hitInfo & HIT_INFO.CRITICALHIT) !== 0 ? CATEGORY_CRIT : CATEGORY_NUMBER;
        return { category, number: String(damage), wordKey: null };
      }
      if ((hitInfo & HIT_INFO.FULL_ABSORB) !== 0) {
        code = 10;
      } else if ((hitInfo & HIT_INFO.FULL_RESIST) !== 0) {
        code = 2;
      } else {
        code = 1;
      }
      break;
    }
  }
  const word = missWord(code);
  return word === null ? null : { category: word.category, number: null, wordKey: word.key };
}

/**
 * WHAT THE CLIENT'S OWN LUA IS TOLD -- the five arguments of `UNIT_COMBAT`, which is the OTHER medium.
 *
 * `playerframe.lua:129-132` is the only handler of that event in this build's FrameXML (measured:
 * `targetframe.lua` has no `CombatFeedback` call and neither does `unitframe.lua`, so the unit-frame
 * feedback text exists on the PLAYER FRAME and nowhere else in 3.3.5a). It forwards
 * `CombatFeedback_OnCombatEvent(self, arg2, arg3, arg4, arg5)`, i.e. `(event, flags, amount, type)`
 * (`combatfeedback.lua:35`), so the shape below is read off the consumer rather than remembered:
 *
 *  - `event` -- `"WOUND"` for a landed or missed swing, or the outcome's own name. The client's table
 *    is keyed by `"MISS"`/`"DODGE"`/`"PARRY"`/`"BLOCK"`/`"EVADE"`/`"IMMUNE"`/`"DEFLECT"`
 *    (`combatfeedback.lua:15-26`) and its final `else` arm resolves any of them directly
 *    (`combatfeedback.lua:88-90`).
 *  - `flags` -- `"CRITICAL"` or `""`. The client also tests `"CRUSHING"` (1.5x font) and `"GLANCING"`
 *    (0.75x) and nothing else (`combatfeedback.lua:44-48`); **neither is emitted here**, because their
 *    bits are the disputed ones -- see `DISPUTED_HIT_INFO_NOTE`.
 *  - `amount` -- the damage. `0` with no flags takes the `WOUND` arm to the MISS word.
 *  - `type` -- the school mask; anything but `SCHOOL_MASK_PHYSICAL` prints yellow.
 *
 * **The outcome mapping is `meleeText`'s, deliberately shared**: one decision drives both media, so the
 * floating word and the portrait word can never disagree about what happened.
 */
export interface CombatFeedbackArgs {
  event: string;
  flags: string;
  amount: number;
  school: number;
}

export function combatFeedbackArgs(
  hitInfo: number,
  victimState: number | null,
  damage: number,
  school: number,
): CombatFeedbackArgs | null {
  const text = meleeText(hitInfo, victimState, damage);
  if (text === null) {
    return null;
  }
  // A WORD outcome names itself; a number is a WOUND. `ABSORB`/`RESIST`/`MISS` come out of the word arm
  // as their own event names, which the client's final `else` resolves the same way -- so the WOUND
  // branch's own absorb/block/resist legs (`combatfeedback.lua:56-67`) are simply not the route we take.
  // Both routes print the same word; this one keeps the two media agreeing by construction.
  if (text.wordKey !== null) {
    return { event: text.wordKey, flags: '', amount: 0, school };
  }
  // CRITICAL only. `"CRUSHING"` and `"GLANCING"` are the client's other two tested flags and their bits
  // are disputed -- see `DISPUTED_HIT_INFO_NOTE`. Both therefore print at the ordinary size, which is
  // stated there.
  const flags = (hitInfo & HIT_INFO.CRITICALHIT) !== 0 ? 'CRITICAL' : '';
  return { event: 'WOUND', flags, amount: damage, school };
}

/**
 * The text and shadow alpha bytes at `elapsedMs` -- `law.rs:266-286`, the reference's
 * `time_alpha_fade 0x6c82e0` composed through the `SetShadowColor 0x5cd650` store seam, which writes
 * the shadow's alpha as `min(shadowLane, textAlpha)` every tick.
 *
 * Branch order is the client's: fade-IN first, so a row whose fade-out start precedes its fade-in end
 * (row 1) has no plateau; then the fade-out arm; else the unconditional `(255, 127)` plateau. Both ramps
 * divide by the row's DURATION and not by their own span -- the reference calls that a byte-verified
 * quirk, and its consequence is that the fade-in boundary is a STEP rather than a ramp arrival.
 * `Math.trunc` because MSVC's `__ftol` truncates.
 */
export function fadeAlpha(cat: Category, elapsedMs: number): { text: number; shadow: number } {
  let text: number;
  let shadow: number;
  if (elapsedMs < cat.fadeInMs) {
    const t = Math.max(0, elapsedMs / cat.durMs);
    text = Math.min(Math.trunc(255 * t), 0xff);
    shadow = Math.min(Math.trunc(127 * t), 0x7f);
  } else if (elapsedMs >= cat.fadeOutMs) {
    const u = (elapsedMs - cat.fadeOutMs) / (cat.durMs - cat.fadeOutMs);
    text = Math.trunc(255 - Math.min(Math.max(255 * u, 0), 255));
    shadow = Math.trunc(255 - Math.min(Math.max(127 * u, 0), 127));
  } else {
    text = 0xff;
    shadow = 0x7f;
  }
  return { text, shadow: Math.min(shadow, text) };
}

/**
 * The category's scale value at normalized life `t` -- `law.rs:291-303`, the reference's
 * `keyframe_interp 0x6c80b0`. Category 2 runs the crit-pop keyframes against `valueHi`; every other row
 * is the affine `lo + (hi - lo) * t`, which is constant because `lo == hi` outside the crit row. Floored
 * at 0.001 as the client clamps.
 */
export function scaleValue(category: number, t: number): number {
  const cat = CATEGORIES[category];
  let v: number;
  if (category === CATEGORY_CRIT) {
    const seg = CRIT_KEYFRAMES.find(([t0, t1]) => t >= t0 && t <= t1) ?? CRIT_KEYFRAMES[2];
    const [t0, t1, s0, s1] = seg;
    v = (s0 + (s1 - s0) * ((t - t0) / (t1 - t0))) * cat.valueHi;
  } else {
    v = cat.valueLo + (cat.valueHi - cat.valueLo) * t;
  }
  return Math.max(v, 0.001);
}

/**
 * A category value -> a height in LOGICAL (768-space) interface units.
 *
 * The reference's law is `text_px(v) = round(v * hypot(W, H))` device pixels (`law.rs:203-220`): one gx
 * unit is the SCREEN DIAGONAL, because the screencoord device space spans `G44 = s/hypot(s,1)` by
 * `G48 = 1/hypot(s,1)` with `s = W/H`, so `v / G48 * H = v * hypot(W, H)`. The reference records that
 * hardcoding G48's 4:3 value under-sizes ~22% at 16:9 and that this was the director's "damage numbers
 * should be 1-2 sizes bigger" -- so the aspect term is load-bearing and is kept.
 *
 * Converted here rather than transcribed: 768 logical units span the viewport's height, so
 * `logical = 768 * px / H = 768 * v * hypot(W, H) / H = 768 * v * hypot(1, aspect)`. **No viewport
 * measurement is needed** -- `camera.aspect` carries `W/H` -- which is what lets this be a pure
 * function.
 *
 * **THE gx PIXEL ROUND IS NOT APPLIED**, and that is a stated deviation rather than an oversight: the
 * reference's `+0.5`-then-truncate quantizes DEVICE pixels, and this function's output is logical
 * units. Rounding here would quantize the wrong quantity (and at a window shorter than 768 it would
 * round a sub-pixel step to a whole pixel). The unrounded error is under half a device pixel.
 */
export function sizeUnits(value: number, aspect: number): number {
  return 768 * value * Math.hypot(1, aspect);
}

/**
 * The shadow offset in LOGICAL units, per axis -- `law.rs:222-236`, the verified static at `0xce8804`
 * (`{0.002, 0.002}`, init `0x6c7c20`): a **viewport FRACTION**, resolved per axis, which the reference
 * corrected from an earlier "x diagonal" reading that overstated the vertical ~2.2x at 16:9.
 *
 * `0.002 * H` device px is `768 * 0.002 = 1.536` logical units down; `0.002 * W` is `1.536 * aspect`
 * across. The Y is returned NEGATIVE because `FontSpec.shadowOffset` keeps FrameXML's `+y` up and
 * `ui/text.ts` is the one place that flips it for the canvas -- the same convention `<Shadow y="-1"/>`
 * uses for one unit down. The reference's integer px round is dropped for `sizeUnits`' reason.
 */
export function shadowOffsetUnits(aspect: number): { x: number; y: number } {
  const y = 768 * 0.002;
  return { x: y * aspect, y: -y };
}

/** ARGB (client-packed) -> straight RGB in 0..1. The packed ALPHA is discarded -- see `Category.color`. */
export function argbRgb(c: number): [number, number, number] {
  return [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255];
}
