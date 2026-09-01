/**
 * THE LOCAL SELF-CANCEL: moving mid-cast ends the cast, on our own client, the same frame.
 *
 * The owner's requirement: a cast "может быть отменен ... движением". This is the movement leg. Escape's
 * leg is `ui/target-bridge.ts#SpellStopCasting` and is the client's own Lua chain (`ToggleGameMenu`
 * :2893); it needs nothing from here.
 *
 * ## Why the client does this locally at all, when the server would do it anyway
 *
 * The server IS the safety net -- TrinityCore's `Spell::update` kills a cast on a 0.5-yd position delta.
 * But that has to accumulate before the server notices, and then the news has to come back: ~150 ms and
 * up. The client cancels on the input edge instead, which is one frame. The reference states exactly
 * this trade (`samples/benilla/crates/benilla-app/src/ui_cast.rs:344-348`): "one engine frame (~16 ms)
 * from key to bar-kill, vs the server round trip (~150 ms+: the 0.5-yd delta has to accumulate before
 * vmangos even notices)".
 *
 * ## What counts as movement -- and TURNING DOES NOT
 *
 * This is the part that would be wrong if guessed. The reference byte-verified the client's own
 * dispatcher (`ui_cast.rs:322-336`, wow-re `move-selfcancel.md` §5): the `Script::Move*` keybind
 * handlers funnel into `0x515090`, whose interrupt mask is `0x10f0` = {forward, backward, strafe left,
 * strafe right, autorun toggle}. **Turn (`0x100`/`0x200`) and pitch (`0x400`/`0x800`) are OUTSIDE the
 * mask and never cancel a cast.** `Script::Jump 0x513bd0` inlines the same gate, so the jump key cancels
 * too -- and on the PRESS, because that handler is the keybind's, not the takeoff's: pressing space
 * while already airborne runs the same gate.
 *
 * So holding A or D in vanilla -- which TURNS rather than strafes -- must not break a cast, while Q/E
 * (strafe) and the same A/D under mouse-look (where they become strafe) must. `controls.tsx` already
 * separates `turning` from `forward`/`strafe` at the point it computes them, which is where the edge is
 * detected; see its call to `onMoveStart`.
 *
 * ## The per-spell gate, and it FAILS OPEN
 *
 * Not every cast is movement-sensitive. The cast half consults the in-flight spell's own
 * `Spell.dbc` `InterruptFlags & 0x1` (`SPELL_INTERRUPT_FLAG_MOVEMENT`), the channel half its
 * `ChannelInterruptFlags & 0x8` -- both columns measured for this build, see
 * `pipeline/dbc/spell-data.ts#COL.interruptFlags` for how the index was pinned rather than ported.
 *
 * An UNCATALOGUED spell cancels, which is the reference's own choice and its reason (`ui_cast.rs:415`):
 * "the gate exists to spare the rare cast-while-moving spell, and failing open matches the server's own
 * verdict for everything ordinary."
 *
 * ## Two halves, and Escape reaches only one of them
 *
 * - **the cast half** (movement or Escape): `CMSG_CANCEL_CAST`, the guard opened, the held pose given
 *   back, and the bar torn down.
 * - **the channel half** (movement ONLY): `CMSG_CANCEL_CHANNELLING` and nothing else -- no local
 *   teardown, because the reference's `0x6e9b70` fires no event and clears no state; the channel bar
 *   closes on the server's `SMSG_CHANNEL_UPDATE(0)`. Escape can never reach a channel: that is the
 *   vanilla "/stopcasting cannot stop a channel" quirk, verified at `ui_cast.rs:366-374` and kept.
 *
 * This client does not yet track a channel separately from a cast -- `CastSnapshot#channeling` exists
 * but nothing sets it, because `SMSG_CHANNEL_START` is not decoded. So the channel half has no state to
 * read and is NOT implemented here; it is named rather than silently skipped, and
 * `SpellHandler#cancelChannelling` is written and waiting for it.
 */
import type World from '../world';
import { spellData } from '../pipeline/dbc/spell-data';

/** `SPELL_INTERRUPT_FLAG_MOVEMENT` -- `Spell.dbc.InterruptFlags` bit 0. See the header. */
export const SPELL_INTERRUPT_MOVEMENT = 0x1;

/**
 * The Lua-side teardown, registered by `ui/target-bridge.ts` while the FrameXML runtime is up.
 *
 * A module-level slot rather than a constructor argument for the reason the several
 * `set*Source`/`set*Handler` hooks in this codebase already take one: the caller of the cancel is the
 * input layer (`pages/game/index.tsx`), which has a `World` and deliberately knows nothing about the
 * Lua VM, while the thing that must fire `UNIT_SPELLCAST_*` is the bridge that owns the VM.
 *
 * **Null is a real state, not a missing case.** Plain `/game` runs the hand-written transcription with
 * no FrameXML host at all, and there the wire cancel and the pose release must still happen -- they are
 * the half that is not about the bar. So the wire work below is unconditional and only the events are
 * gated on this.
 */
let castBarTeardown: ((spellId: number) => void) | null = null;

export function setCastBarTeardown(fn: ((spellId: number) => void) | null): void {
  castBarTeardown = fn;
}

/**
 * A cancel-worthy local movement edge happened: a directional start (forward / backward / strafe) or a
 * jump-key press. Cancel the cast if there is one and its own flags say movement breaks it.
 *
 * Returns the spell id it cancelled, or null -- so the caller and a test can assert the DECISION rather
 * than the state it wrote.
 */
export default function cancelCastOnMove(world: World): number | null {
  const spells = world.game?.objectHandler?.spellHandler;
  if (!spells) {
    return null;
  }

  // `currentCast` and not the cast-bar snapshot, and this is the whole reason the in-flight guard is
  // read here: the snapshot only exists once `SMSG_SPELL_START` has arrived, so a player who presses a
  // spell and immediately runs would have nothing to cancel for the length of the round trip. The
  // guard is armed on the SEND, so it covers that window.
  const spellId = spells.currentCast();
  if (spellId === null) {
    return null;
  }

  // FAILS OPEN for an unknown spell -- see the header.
  const row = spellData.spell(spellId);
  if (row !== null && (row.interruptFlags & SPELL_INTERRUPT_MOVEMENT) === 0) {
    return null;
  }

  // `castCount` 0, which is what `castSpell` sent for this cast. `cancelCast` opens the in-flight guard
  // itself, so the next press is not refused as a duplicate of a cast that is already gone.
  if (!world.session?.offline) {
    spells.cancelCast(spellId, 0);
  } else {
    // Offline there is no wire, but the guard still has to open or casting would lock up after one
    // cancelled cast in the offline world.
    spells.releaseCastGuard(spellId);
  }

  // The held pose is a LOOP and `Unit#externalSeq`'s release never fires for a loop, so a cast that
  // ends without reaching `SMSG_SPELL_GO` must hand the body back explicitly or the caster stands in
  // his cast pose for the rest of the session. Both of `releaseCastPose`'s identity guards apply.
  spells.releaseCastPose(world.player?.guid ?? null, spellId);

  // The bar, only when there is a FrameXML runtime to tell.
  castBarTeardown?.(spellId);

  return spellId;
}
