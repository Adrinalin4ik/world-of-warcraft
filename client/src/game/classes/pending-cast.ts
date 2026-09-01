/**
 * THE OPTIMISTIC IN-FLIGHT CAST GUARD -- what stops a second press of a spell from killing the cast
 * already running.
 *
 * ## The bug this exists for, and why the fix cannot live on the receive side
 *
 * The owner's report: "Каст способностей не должен прерываться повторным нажатием." Pressing the same
 * ability again mid-cast tore the cast bar down.
 *
 * The cast was never actually interrupted -- the server kept casting it. What happened is that the
 * SECOND press went out as a second `CMSG_CAST_SPELL`, the server refused it (TrinityCore's
 * `Spell::CheckCast` answers `SPELL_FAILED_SPELL_IN_PROGRESS` when
 * `Unit::IsNonMeleeSpellCast` is true), and the refusal came back as `SMSG_CAST_FAILED`. Our
 * `action-bridge.ts#onCastFailed` took any `SMSG_CAST_FAILED` as the end of the cast, cleared the
 * snapshot and fired `UNIT_SPELLCAST_FAILED` -- so the refusal of press two closed the bar of press
 * one. The first cast then completed on the server and its `SMSG_SPELL_GO` found nothing to close.
 *
 * **The reference names this exact failure and fixes it at the source rather than on the receive
 * side** (`samples/benilla/crates/benilla-app/src/ui_cast.rs:69-83`): "Ours was server-driven: every
 * mashed key fired a *duplicate* cast, the server rejected the dupe with `SMSG_CAST_RESULT` failure,
 * and that turned the running cast's bar red while the original completed later. This marker drops the
 * duplicate at the source, exactly as the client does."
 *
 * A receive-side filter cannot do it. `SMSG_CAST_FAILED` carries a `castCount` that would identify
 * which press failed, but this client sends **0** for every cast (`network/game/object/spells.ts`
 * `castSpell`), so both presses claim the same count and no match is possible. And even with a real
 * counter the filter would be the wrong answer: the real client sends no second packet at all.
 *
 * ## What the real client does with the second press -- checked, not assumed
 *
 * `Spell_C::TryCast 0x6e4b60` refuses to send while `IsCasting 0x6e3d30` is set, and the two arms are
 * different (`ui_cast.rs:70-76`, `ui_action/cast_send.rs:283-297`):
 *
 *  - **the SAME spell bails silently** (`6e4d43`) -- no packet, no error line, nothing;
 *  - **a DIFFERENT spell errors with reason 0x61**, "Another action is in progress" (`6e4d97`), and
 *    still sends no packet.
 *
 * So the answer to "ignored, or queued?" is **ignored**, and locally. There is no cast queue in 3.3.5a.
 *
 * ## Why the guard is OPTIMISTIC, and why that is the whole point
 *
 * It is armed the instant we SEND, not when `SMSG_SPELL_START` echoes back -- because the mashing lands
 * during exactly that round trip. A guard keyed on the cast snapshot (which `SMSG_SPELL_START` creates)
 * would let every press inside the first ~150 ms straight through, which is most of them.
 *
 * `deadline` is only a safety net for a resolution packet that never arrives; the resolution normally
 * clears the guard long before it. It is armed generously and then tightened to the server's real cast
 * time the moment START names one -- the reference's `arm`/`refine` pair (`ui_cast.rs:117-152`).
 */

/**
 * The provisional window armed at send, before `SMSG_SPELL_START` names the real cast time. It only
 * has to outlast the send -> START round trip.
 *
 * 5 s, the reference's own `SEND_PROVISIONAL` (`ui_cast.rs:49`), and generous on purpose for the reason
 * it gives: every `CMSG_CAST_SPELL` the server accepts or refuses is answered by a packet, so this
 * deadline never actually governs a live cast -- it governs a lost one. An INSTANT never reaches it
 * either: its `SMSG_SPELL_GO` clears the guard first.
 */
const SEND_PROVISIONAL_MS = 5000;

/**
 * Slack added to the server's cast time at `SMSG_SPELL_START`, so a cast the server pushes back
 * (`SMSG_SPELL_DELAYED`) still guards past its stretched end. The reference's `CAST_SLACK`
 * (`ui_cast.rs:66`).
 */
const CAST_SLACK_MS = 2000;

interface PendingState {
  spellId: number;
  deadlineMs: number;
}

/**
 * Our own outstanding cast. One slot: the client has one too (`0xceca88`, the inflight spell id).
 *
 * Times are `Date.now()` milliseconds and every method takes `now` so the whole thing is testable
 * without a clock.
 */
export default class PendingCast {
  private state: PendingState | null = null;

  /** Whether a cast we sent is still outstanding -- unresolved and inside its safety deadline. */
  inFlight(now: number): boolean {
    return this.state !== null && now < this.state.deadlineMs;
  }

  /** The outstanding cast's spell id, or null. The two refusal arms above fork on comparing this. */
  current(now: number): number | null {
    if (this.state === null || now >= this.state.deadlineMs) {
      return null;
    }
    return this.state.spellId;
  }

  /** Arm on a fresh send -- the optimistic write, before the server has said anything. */
  arm(spellId: number, now: number): void {
    this.state = { spellId, deadlineMs: now + SEND_PROVISIONAL_MS };
  }

  /** Tighten the deadline to the server's real cast time once `SMSG_SPELL_START` names it. */
  refine(castTimeMs: number, now: number): void {
    if (this.state !== null) {
      this.state.deadlineMs = now + castTimeMs + CAST_SLACK_MS;
    }
  }

  /**
   * Push the deadline out by a pushback (`SMSG_SPELL_DELAYED`).
   *
   * Extended from whichever is LATER, the current deadline or now -- the reference's own rule
   * (`ui_cast.rs:149-155`), so a deadline that has already lapsed from an under-estimate still re-arms
   * rather than being pushed to a moment already past.
   */
  delay(delayMs: number, now: number): void {
    if (this.state !== null) {
      this.state.deadlineMs = Math.max(this.state.deadlineMs, now) + delayMs;
    }
  }

  /**
   * Clear when the RESOLVING spell is our outstanding one.
   *
   * Spell-id-keyed, and that is load-bearing: a triggered proc's `SMSG_SPELL_GO` arriving mid-cast
   * names a different spell and must not open the gate early (`ui_cast.rs:157-162`).
   */
  clearIf(spellId: number): void {
    if (this.state !== null && this.state.spellId === spellId) {
      this.state = null;
    }
  }

  /** Drop the guard whatever it holds -- leaving the world, and the tests' reset. */
  clear(): void {
    this.state = null;
  }
}
