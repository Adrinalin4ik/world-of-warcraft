import { SERVICE_RANGE_SQ } from './cursor-mode';
import type Unit from '../classes/unit';

/**
 * THINGS THAT END WHEN YOU WALK AWAY -- the NPC-window range guard, and the loot's movement interrupt.
 *
 * Two of the owner's rules, and they are one shape: a session that stays open because nothing was
 * watching the player.
 *
 * ## THE NPC WINDOWS -- the reference's own standardised guard
 *
 * "The **NPC-session range guard** -- the one standardized rule for every UI window bound to a live NPC
 * (merchant stock, gossip menu, questgiver panel): when the player walks out of the NPC-service range,
 * or the NPC despawns, the window client-side-closes. That close is the exact no-packet clear the
 * window's own close button does (vanilla sends nothing for any of the three)"
 * (`benilla-app/src/ui_session.rs:1-6`).
 *
 * The threshold is its threshold and its reasoning: `SERVICE_RANGE_SQ`, "the byte-verified NPC-service
 * gate the cursor grays at ... so a window closes exactly where the cursor says its NPC is out of
 * service -- one law for 'out of service'". It also flags what is inferred rather than verified --
 * "whether the real client's auto-close shares that exact gate is INFERRED (its close mechanism isn't
 * RE'd); the constant is the knob if it reads too eager or too lax in play" -- so that caveat travels
 * with the port rather than being dropped at the border.
 *
 * Our four sessions each already own the right close: `gossip.close()`, `merchant.close()`,
 * `trainer.close()` and `quest.closePanels()` are all no-packet clears, which is why this file needs to
 * add no new closing path. **`quest.cancel()` is deliberately NOT used** -- that sends
 * `CMSG_QUESTGIVER_CANCEL`, and the reference is explicit that vanilla sends nothing when a window
 * closes this way.
 *
 * NOT guarded, and named: trade. The reference excludes it for a reason that applies here too -- "its
 * cancel is server-driven" -- and this client has no trade window anyway.
 *
 * ## THE LOOT -- ours, and stated as ours
 *
 * The owner: "когда я собираю лут я могу двигаться. Лут должен прерываться при движении как и
 * анимация." He is describing the game's behaviour correctly. **The reference does not model it**: its
 * `ui_loot` has only the client-authoritative close-on-last-slot (`auto_release`), and nothing about
 * movement. So the mechanism here is OURS: on movement we send `CMSG_LOOT_RELEASE`, and the window
 * closes through `SMSG_LOOT_RELEASE_RESPONSE` exactly as the close button's does -- no second closing
 * path, and the kneel drops with it because `LootHandler#kneel(false)` hangs off that same close.
 *
 * A SEND rather than a local clear, which is the important half: the server holds the loot open for us,
 * so clearing locally would leave it held and the corpse unlootable by anyone until it decayed.
 *
 * ## COST
 *
 * One squared-distance compare per open window per frame, and one squared speed compare while a loot
 * window is open. Nothing is allocated and nothing runs at all with no window open -- the guard reads
 * four `source` fields, which are null in the ordinary case. Zero UI draw-fingerprint by construction:
 * a close writes Lua state through the handler's own events, exactly as the close button does, so a
 * frame where nothing closes touches no draw item.
 */

/** A session bound to an NPC: the guid it is bound to, and its own no-packet clear. */
export interface NpcSession {
  /** The NPC's guid, or null when nothing is open. */
  npc(): string | null;
  /** The window's client-side close. No packet -- see the header. */
  close(): void;
  /** For the console arm and the warning, so a close can name itself. */
  readonly label: string;
}

/** What the guard needs of the loot, without knowing what a loot handler is. */
export interface LootSession {
  /** Is a loot window open? */
  isOpen(): boolean;
  /** `CMSG_LOOT_RELEASE` -- see the header on why this is a send. */
  release(): void;
}

/**
 * Squared yards of player movement per second past which looting is considered interrupted.
 *
 * OURS. A stationary player's speed is not exactly zero -- a settle after a teleport, a step off a
 * slope, the mover's own integration -- so testing `> 0` would close the window under a player who
 * had not moved. One yard per second is well under a walk (2.5) and far above any settle.
 */
const LOOT_INTERRUPT_SPEED_SQ = 1;

export class SessionGuard {
  private sessions: NpcSession[] = [];

  private loot: LootSession | null = null;

  /** `window.worldSessionGuard()` reads this. */
  public stats = { closedOutOfRange: 0, closedGone: 0, lootInterrupted: 0 };

  register(session: NpcSession): void {
    this.sessions.push(session);
  }

  registerLoot(loot: LootSession): void {
    this.loot = loot;
  }

  /**
   * One frame. `entities` is the world's guid registry, so an NPC that despawned is simply absent.
   *
   * `speedSq` is the player's squared horizontal speed in yd/s -- passed in rather than read, because
   * which of the mover's several velocities is the real one is the world's business and not this file's.
   */
  update(entities: Map<string, Unit>, player: Unit | null, speedSq: number): void {
    if (player === null) {
      return;
    }
    for (const session of this.sessions) {
      const guid = session.npc();
      if (guid === null) {
        continue;
      }
      const npc = entities.get(guid);
      if (npc === undefined) {
        // The NPC despawned or streamed out. The reference closes on this too, and it is the case that
        // would otherwise leave a window bound to a guid nothing can answer for.
        session.close();
        this.stats.closedGone += 1;
        continue;
      }
      if (npc.position.distanceToSquared(player.position) > SERVICE_RANGE_SQ) {
        session.close();
        this.stats.closedOutOfRange += 1;
      }
    }

    if (this.loot !== null && this.loot.isOpen() && speedSq > LOOT_INTERRUPT_SPEED_SQ) {
      this.loot.release();
      this.stats.lootInterrupted += 1;
    }
  }
}

export default SessionGuard;
