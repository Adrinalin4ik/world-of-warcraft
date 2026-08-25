/**
 * WALK AWAY AND THE WINDOW SHUTS -- the vendor's, the trainer's and the corpse's, through ONE
 * mechanism.
 *
 * The owner reported the first two separately -- "walking away from the vendor does not close the
 * window" and the same of the loot window -- and the trainer arrived later by the same report. They are
 * not three bugs. Nothing in this client was watching an open interaction at all, so every window
 * opened by walking up to something stayed open until it was dismissed by hand.
 *
 * The trainer needed no new radius and no new rule, which is the check on the shape of this file: it is
 * one more row in the `services` table below, and nothing else changed.
 *
 * ## WHOSE JOB IS THIS? Neither the server's nor the document's -- so it is the engine's, i.e. ours
 *
 * That was established rather than assumed, because getting it wrong means either a window that never
 * closes or one that closes while the server still thinks it is open.
 *
 *  - **The SERVER does not close them.** TrinityCore 3.3.5 has no periodic interaction-distance check:
 *    grepped, the only `DoLootRelease` that is not a response to a client packet is in
 *    `Player::RemoveFromWorld` (`Player.cpp:1854-1856`), i.e. logout, and there is no merchant-side
 *    equivalent at all -- 3.3.5a has no `SMSG_MERCHANT_CLOSE` opcode for one to arrive on.
 *  - **The DOCUMENTS do not close them.** `MerchantFrame_OnLoad` registers `MERCHANT_UPDATE`,
 *    `MERCHANT_CLOSED`, `MERCHANT_SHOW` and `GUILDBANK_UPDATE_MONEY` (`merchantframe.lua:7-10`);
 *    `LootFrame_OnLoad` registers the four loot events (`lootframe.lua:6-11`). Neither watches
 *    distance, movement or the target. They only ANSWER `MERCHANT_CLOSED` / `LOOT_CLOSED`.
 *  - **The REFERENCE does not have this either** -- `ui_merchant.rs` and `ui_loot.rs` know "too far" only
 *    as a server refusal string. So this is not a port, and it is not marked as one.
 *
 * Therefore the engine raises those two events off its own watch, and this module is that watch. Its
 * SHAPE is ours; every DISTANCE in it is the game's, taken from `world/cursor-mode.ts`, which is the
 * one place this client keeps interaction ranges.
 *
 * ## The ranges, and why they differ
 *
 *  - **A vendor closes at `SERVICE_RANGE_SQ`** (5.5556 yd, squared 30.864). Not a choice: it is the
 *    same gate the SERVER refuses on -- `GetNPCIfCanInteractWith` tests `INTERACTION_DISTANCE` -- so
 *    inside it every button works and outside it every button is refused. Closing exactly there is the
 *    only radius at which the window is never lying.
 *  - **A corpse closes at the melee interact reach**, `max(reachA + reachB + 1.3333, 5.0)` squared,
 *    which is what gates the Loot cursor and `CanLootNow`. A big corpse is lootable from farther, so a
 *    fixed radius would shut the window while the client's own cursor still said Pickup.
 *
 * ## Two states, two different closes, and conflating them loses a window
 *
 * `far` means the thing is still there and we have moved. `gone` means we no longer hold an entity for
 * the guid at all -- it despawned, or left our update range.
 *
 *  - A vendor takes `close()` for both: there is no packet to send either way.
 *  - A corpse takes `release()` when FAR (`CMSG_LOOT_RELEASE`, so the server drops its own loot state
 *    and the window shuts on `SMSG_LOOT_RELEASE_RESPONSE`) and `close()` when GONE -- which is the case
 *    `LootHandler#close`'s own comment already names, "for a disconnect or a corpse that despawned".
 *    Sending a release for a corpse that no longer exists would wait for a reply that never comes.
 *
 * ## `gone` requires having SEEN it, and that guard is load-bearing
 *
 * A loot source is not always a unit in `world.entities`: a lockbox is an ITEM guid and a chest is a
 * GameObject, neither of which this client puts there. Closing on "not in `entities`" alone would shut
 * such a window the instant it opened. So a source is only ever `gone` if we DID hold an entity for it
 * and have since stopped -- an unknown guid is left alone, which is the conservative direction.
 *
 * ## Cost
 *
 * **Polled, not per frame, and only while something is open.** `INTERACTION_POLL_MS` is 250: a player
 * runs at ~7 yd/s, so the worst overshoot past the gate before the window notices is ~1.75 yd, well
 * inside the distance at which the next click would be refused anyway. With both windows shut this is
 * two null checks; with one open it is one `distanceToSquared` per poll, i.e. four per second. Nothing
 * is added to the draw list and nothing dirties the interface fingerprint -- the close raises an event,
 * and an event that changes the screen SHOULD dirty it.
 */
import type World from '../world';
import { SERVICE_RANGE_SQ, interactReachSq } from '../world/cursor-mode';
import type { MerchantHandler } from '../../network/game/object/merchant';
import type { LootHandler } from '../../network/game/object/loot';
import type { TrainerHandler } from '../../network/game/object/trainer';

/**
 * How often the open interaction is checked, in milliseconds.
 *
 * 250 is a budget decision with a number on it -- see the header's Cost note. It is NOT a frame count:
 * a poll tied to frames would check eight times as often on a fast machine and change behaviour with
 * the frame rate, which is the class of bug this project has already paid for elsewhere.
 */
export const INTERACTION_POLL_MS = 250;

/** What the watch decided about one open interaction. */
export type InteractionVerdict = 'keep' | 'far' | 'gone';

/**
 * The DECISION, pure and separately testable.
 *
 * `seen` is whether an entity for this guid was ever resolved. See the header on why `gone` needs it.
 */
export function verdictFor(
  distanceSq: number | null,
  rangeSq: number,
  seen: boolean,
): InteractionVerdict {
  if (distanceSq === null) {
    // No entity right now. Only a source we HAD resolved counts as gone; an unknown guid (an item or a
    // GameObject loot source) is left alone.
    return seen ? 'gone' : 'keep';
  }
  return distanceSq > rangeSq ? 'far' : 'keep';
}

/**
 * Watch the open vendor and the open corpse; close whichever the player has walked away from.
 *
 * Returns the poll to drive and the teardown. `world-ui.ts` drives it from its own per-frame `render`,
 * which is the only loop in this client that is already running whenever the interface exists.
 */
export function attachInteractionWatch(world: World): {
  poll: (nowMs: number) => void;
  dispose: () => void;
} {
  const merchant: MerchantHandler = world.game.objectHandler.merchantHandler;
  const loot: LootHandler = world.game.objectHandler.lootHandler;
  const trainer: TrainerHandler = world.game.objectHandler.trainerHandler;

  let nextPollAt = 0;
  /** Guids we have successfully resolved to an entity while their window was open. */
  const seen = new Set<string>();

  /** Squared distance from the player to a guid's entity, or null when we hold no entity for it. */
  const distanceSqTo = (guid: string): number | null => {
    const unit = world.entities.get(guid);
    if (unit === undefined) {
      return null;
    }
    seen.add(guid);
    return unit.position.distanceToSquared(world.player.position);
  };

  /**
   * THE SERVICE-SHAPED SOURCES: a window opened by walking up to an NPC and refused by the server at
   * `INTERACTION_DISTANCE`.
   *
   * A TRAINER IS THE SAME SHAPE AS A VENDOR in all four ways this watch cares about, which is why it
   * takes the same radius rather than a new one:
   *
   *  1. the server gates it on the same distance, and this was read rather than assumed:
   *     `HandleTrainerListOpcode` is
   *     `GetNPCIfCanInteractWith(packet.Unit, UNIT_NPC_FLAG_TRAINER)` (`NPCHandler.cpp:92`) -- the
   *     identical call the vendor path makes with `..._VENDOR`, and the `INTERACTION_DISTANCE` test
   *     lives inside it. So inside `SERVICE_RANGE_SQ` every button works and outside it every button
   *     is refused, which is what makes closing exactly there the only radius that cannot lie;
   *  2. there is no close opcode either way (`TrainerHandler#close`: the trainer family is 0x1B0..0x1B4
   *     and none of them is a close), so `close()` is the whole action;
   *  3. its close is the client's own, the same way `MERCHANT_CLOSED` is -- the handler emits, the
   *     bridge raises, the document hides itself;
   *  4. its source is a UNIT we hold an entity for, so `gone` means what it means for a vendor.
   *
   * A table rather than three copies of the block, because the next service window -- a banker, an
   * innkeeper, an auctioneer -- is the same four facts again, and the loop below should not have to
   * grow for it. The CORPSE is deliberately NOT in here: its radius is different and its close sends a
   * packet, which is the whole reason it is handled separately.
   */
  const services: Array<{ name: string; handler: { source: string | null; close: () => void } }> = [
    { name: 'merchant', handler: merchant },
    { name: 'trainer', handler: trainer },
  ];

  const poll = (nowMs: number): void => {
    if (nowMs < nextPollAt) {
      return;
    }
    nextPollAt = nowMs + INTERACTION_POLL_MS;

    // EVERY SERVICE-SHAPED SOURCE, one loop. A trainer is the same shape as a vendor in all four ways
    // that matter here -- see the `services` table.
    for (const service of services) {
      const guid = service.handler.source;
      if (guid === null) {
        continue;
      }
      if (verdictFor(distanceSqTo(guid), SERVICE_RANGE_SQ, seen.has(guid)) !== 'keep') {
        // `far` and `gone` are the same call: 3.3.5a has no close opcode for either window, so there is
        // nothing to tell the server. `close()` emits the handler's own closed event, the bridge raises
        // the document's (`MERCHANT_CLOSED` / `TRAINER_CLOSED`), and the frame answers it with
        // `HideUIPanel(self)` -- whose `OnHide` calls `CloseMerchant()`/`CloseTrainer()` straight back
        // into a handler whose source is now null, which is a no-op. No loop.
        seen.delete(guid);
        service.handler.close();
      }
    }

    const corpse = loot.source;
    if (corpse !== null) {
      const unit = world.entities.get(corpse);
      // The reach depends on BOTH combat reaches, so it is recomputed per poll rather than cached:
      // `interactReachSq` reads `UNIT_FIELD_COMBATREACH`, which arrives in a create block and can land
      // after the window opens.
      const rangeSq = interactReachSq(world.player, unit ?? null);
      const verdict = verdictFor(distanceSqTo(corpse), rangeSq, seen.has(corpse));
      if (verdict === 'far') {
        seen.delete(corpse);
        // TELL THE SERVER. It still holds loot state for this corpse, and `SMSG_LOOT_RELEASE_RESPONSE`
        // is what actually empties the window -- the same one-source-of-truth law `LootHandler#release`
        // already keeps.
        loot.release();
      } else if (verdict === 'gone') {
        seen.delete(corpse);
        // Nothing to release to. `LootHandler#close`'s own comment names this case.
        loot.close();
      }
    }
  };

  /** A window closing by any other route must not leave its guid remembered as "seen". */
  const forget = (): void => { seen.clear(); };
  merchant.on('merchantClosed', forget);
  trainer.on('trainerClosed', forget);
  loot.on('lootClosed', forget);

  (window as unknown as Record<string, unknown>).interactionWatch = () => ({
    vendor: merchant.source,
    trainer: trainer.source,
    corpse: loot.source,
    seen: [...seen],
    pollMs: INTERACTION_POLL_MS,
    vendorDistanceSq: merchant.source === null ? null : distanceSqTo(merchant.source),
    trainerDistanceSq: trainer.source === null ? null : distanceSqTo(trainer.source),
    corpseDistanceSq: loot.source === null ? null : distanceSqTo(loot.source),
    serviceRangeSq: SERVICE_RANGE_SQ,
  });

  return {
    poll,
    dispose: () => {
      merchant.removeListener('merchantClosed', forget);
      trainer.removeListener('trainerClosed', forget);
      loot.removeListener('lootClosed', forget);
      delete (window as unknown as Record<string, unknown>).interactionWatch;
    },
  };
}

export default attachInteractionWatch;
