/**
 * WHERE A ONE-SHOT GOES THIS PLAY: onto the upper body over the gait, or onto the whole body.
 *
 * This is the answer to the owner's report -- "if I fight and moving it looks so bad, it chooses the
 * fight animation and it's like moving in fight stance" -- and his own instinct for the shape ("bottom
 * part of the body is movement and upper is the fight") is the client's mechanism, not an
 * approximation of it.
 *
 * A port of `route_oneshot` (`samples/benilla/crates/benilla/src/creature_anim/select.rs:941-961`),
 * the client's `esi` decision `0x5fe6c8..0x5fe74d` (decision 0087, wow-re `anim-composition-model.md`
 * §3/§5). Its own summary of the rule is the thing to hold on to: **masked** onto the SpineLow overlay
 * "when the lower body is committed -- moving/turning/swimming (`[9e8] & 0x20003f`), a non-Stand
 * stand-state (seated/sleep/kneel/chair), or a combat id while airborne
 * (`activeCMovement+0x40 & 0x2000`); full-body on bone 0 when standing idle (none of those). The id
 * gates only *which* tests apply (CLASS_A gates the block; COMBAT gates the airborne test); it never
 * decides maskability by itself -- **the same Attack1H is full-body standing and masked running**."
 *
 * That last sentence is why this is a per-play routing function and not a table of "masked animations".
 *
 * WHY THE MOVE MASK IS THE ONE IT IS. `0x20003f` is the four translation bits plus the two turn bits
 * plus SWIMMING, against `movement/net-motion.ts#MoveFlag`: `0x1|0x2|0x4|0x8|0x10|0x20 = 0x3f` and
 * `SWIMMING = 0x200000`. The two agree exactly, which is the corroboration this project asks for
 * before trusting a mask. Note this is WIDER than `ANY_MOVE` (the turn bits are in it): a fighter
 * turning in place has a committed lower body, which is the reference's own distinction from its
 * `CAST_PIN_MOVE` (`select.rs:185-196`).
 */

import { MoveFlag } from '../movement/net-motion';

/** Where a requested one-shot plays this time round. */
export const enum OneShotRoute {
  /** On the upper body, over a live gait. The legs keep running. */
  Masked,
  /** On the whole body, replacing the base -- the behaviour this client has always had. */
  FullBody,
}

/**
 * The client's `0x5fe6dc` move mask -- `0x20003f`. Translation, TURNING, and swim.
 *
 * Spelled out from `MoveFlag` rather than written as the literal so it cannot drift from the bits the
 * movement layer actually sets. `ROUTE_COMMITTED_MOVE` in the reference (`select.rs:185-186`).
 */
export const ROUTE_COMMITTED_MOVE = MoveFlag.FORWARD | MoveFlag.BACKWARD
  | MoveFlag.STRAFE_LEFT | MoveFlag.STRAFE_RIGHT
  | MoveFlag.TURN_LEFT | MoveFlag.TURN_RIGHT
  | MoveFlag.SWIMMING;

/**
 * CLASS_A membership (the client's `0x5fed90`) -- the maskable-eligible set. A non-member is always
 * full body.
 *
 * Transcribed from `select.rs:966-971`, including its own caveat: "the load-bearing memberships were
 * byte-decoded (17/66/68/80 in; the 37-45 jump/swim/locomotion band excluded); the patchy interior of
 * the wide ranges is INFERRED but never load-bearing here -- the only ids that reach `route_oneshot`
 * are swings, emotes, and the spell-kit cast anims (32/33/51-54), all squarely inside these ranges."
 * The same is true of the ids that reach it here: swings (16-19/85/87/88/117), the defense reactions
 * (20-24/30), casts (51-54) and wire emotes.
 */
export function isClassA(id: number): boolean {
  return id === 2 || (id >= 8 && id <= 10) || (id >= 14 && id <= 36)
    || (id >= 46 && id <= 49) || (id >= 51 && id <= 90)
    || (id >= 105 && id <= 113) || id === 117 || id === 118
    || (id >= 122 && id <= 138) || id === 185 || id === 186 || id === 195;
}

/**
 * COMBAT membership (the client's `0x5fcc10`) -- the set whose AIRBORNE test can reach the mask, i.e.
 * a mid-jump swing. `select.rs:977-980`: "byte-decoded memberships: 17 in, and 66/68/80 NOT (the
 * emotes never mask on airborne alone). Every swing id (16-19/85/87/88/117) is in it; no emote id is
 * -- and no CAST id (32/33/51-54) either."
 */
export function isCombatId(id: number): boolean {
  return id === 10 || (id >= 16 && id <= 24) || id === 30 || id === 36
    || (id >= 57 && id <= 59) || (id >= 85 && id <= 88) || id === 95
    || id === 117 || id === 118;
}

/**
 * The client's **CAST** classifier `0x5fcbb0` -- the spell-cast RELEASE anims `{2, 32, 33, 53, 54}`
 * (`select.rs:623-632`, byte-decoded in wow-re `oneshot-lifecycle.md` section 7).
 *
 * **NOT the ReadySpell HOLDS 51/52**, and the reference is explicit about why: those are their own set
 * (`0x5fde40`) and "a jump over a standing hold really does take the whole body". So a jump during a
 * held cast pose replaces it, which is what this client already does and must keep doing.
 *
 * Together with `isCombatAnim` this is the pair the TRANSPLANT predicate (`0x5feae0`) tests on the
 * clip currently armed on bone 0.
 */
export function isCastAnim(id: number): boolean {
  return id === 2 || id === 32 || id === 33 || id === 53 || id === 54;
}

/**
 * The client's `0x5fcc10` membership again, under the name the FAST PATH and the TRANSPLANT use for it
 * (`select.rs:619-621`, `is_combat_anim`).
 *
 * The reference has two predicates with this identical body -- `is_combat` (which gates the airborne
 * leg of `route_oneshot`) and `is_combat_anim` (which gates the combat fast-path and the transplant).
 * They are the SAME table at the same address, so this is an alias rather than a second copy: writing
 * the ranges twice is how the two would drift.
 */
export const isCombatAnim = isCombatId;

/**
 * The forced-full-body carve-outs (`select.rs:984-987`): the Death class `{1,6,131,132}` (`0x5fda90`)
 * and the sit transitions `{57,58,118}` (`0x5fec60`) go to bone 0 whatever the state.
 *
 * Death matters here in a way it does not in the reference, which never feeds these through the
 * one-shot path: `Unit#setDead` arms DEATH through the same `setAnimation` this routes, and a masked
 * death would leave a corpse's legs running.
 */
export function isForcedFullBody(id: number): boolean {
  return id === 1 || id === 6 || id === 131 || id === 132
    || id === 57 || id === 58 || id === 118;
}

/**
 * Route one requested one-shot from the unit's LIVE state.
 *
 * `standState` is the reference's seated/sleep/kneel/chair leg, and in this client it is always 0 --
 * **a stated gap, not a silent one**: 3.3.5a carries the stand state in `UNIT_FIELD_BYTES_1` byte 0
 * and nothing in this repo decodes `BYTES_1` at all (grep: no reader, no writer). So a seated unit's
 * emote routes full body here where the client would mask it. The parameter exists so the day
 * `BYTES_1` is decoded the call site is the only thing that changes.
 */
export function routeOneShot(id: number, flags: number, standState: number = 0): OneShotRoute {
  if (isForcedFullBody(id) || !isClassA(id)) {
    return OneShotRoute.FullBody;
  }
  const committedLower = (flags & ROUTE_COMMITTED_MOVE) !== 0
    || standState !== 0
    || (isCombatId(id) && (flags & MoveFlag.FALLING) !== 0);
  return committedLower ? OneShotRoute.Masked : OneShotRoute.FullBody;
}
