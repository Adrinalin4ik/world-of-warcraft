/**
 * REPUTATION, off the wire: `SMSG_INITIALIZE_FACTIONS` and the two updates that follow it.
 *
 * The reputation pane had no feed at all -- `api/units.ts` declared `GetNumFactions` and its five
 * companions as gaps with the note "SMSG_INITIALIZE_FACTIONS (0x122) has no subscriber". This is the
 * subscriber. The DBC half of the join is `pipeline/dbc/faction-data.ts`; the Lua globals are
 * `ui/reputation-bridge.ts`.
 *
 * ## THE LAYOUT COMES FROM A SERVER IMPLEMENTATION, and is labelled as such
 *
 * Nothing in the served client files describes this packet, so the only source is TrinityCore's
 * `ReputationMgr::SendInitialReputations` for 3.3.5:
 *
 *     uint32 count            -- 0x80, i.e. 128
 *     count x { uint8 flags; uint32 standing; }
 *
 * indexed by `Faction.dbc`'s `reputationIndex`, which is why the DBC join is keyed on that column and
 * not on the faction id. `faction.dbc` has 105 rows with `reputationIndex >= 0` and a maximum index of
 * **104**, so 128 slots comfortably covers the table -- that agreement is the one independent check on
 * the layout available without a capture, and it is a weak one. **If a faction's standing looks shifted,
 * suspect this layout before the DBC join.**
 *
 * The body is a fixed `4 + 128*5 = 644` bytes. It is read against the packet's own `count` rather than
 * against 128, and clamped to what the body can hold, so a server that sends a different number does not
 * over-read -- the failure mode `byte-buffer` turns into a throw that would escape the receive loop.
 *
 * **The `readCString` empty-terminator hazard does not apply here**: this packet carries no strings. That
 * is worth stating because it has corrupted two other decodes in this project and is the first thing to
 * suspect on a shifted field elsewhere.
 *
 * ## The flag bits, also server-sourced
 *
 * `FactionFlags` from the same implementation. Only three are read here and each is used by exactly one
 * thing the pane draws; the rest are recorded so nobody re-derives them:
 *
 *     0x01 VISIBLE           -- the faction appears in the pane at all
 *     0x02 AT_WAR            -- `GetFactionInfo`'s `atWarWith`
 *     0x04 HIDDEN            -- never shown
 *     0x08 INVISIBLE_FORCED  -- never shown, server-forced
 *     0x10 PEACE_FORCED      -- war cannot be declared, so `canToggleAtWar` is false
 *     0x20 INACTIVE          -- the player parked it at the bottom of the list
 *     0x40 RIVAL
 *     0x80 SPECIAL
 */
import GameOpcode from '../opcode';

/** `FactionFlags`. See the file header -- server-sourced. */
export const FACTION_FLAG_VISIBLE = 0x01;
export const FACTION_FLAG_AT_WAR = 0x02;
export const FACTION_FLAG_HIDDEN = 0x04;
export const FACTION_FLAG_INVISIBLE_FORCED = 0x08;
export const FACTION_FLAG_PEACE_FORCED = 0x10;
export const FACTION_FLAG_INACTIVE = 0x20;

/** One faction's live state, keyed by `Faction.dbc`'s `reputationIndex`. */
export interface FactionStanding {
  flags: number;
  standing: number;
}

/** The bytes a single (flags, standing) pair costs. See the header. */
const PAIR_BYTES = 5;

/**
 * A ceiling on how many pairs will be read, whatever the packet claims.
 *
 * 128 is what the server sends and 105 is the most the DBC could use, so anything past this is a
 * malformed length rather than a build difference worth honouring.
 */
const MAX_PAIRS = 256;

export class ReputationHandler {
  private standings = new Map<number, FactionStanding>();

  /** Bumped on every change, so a bridge can skip a pointless event. */
  private revision = 0;

  constructor(private game: any) {
    this.game.on('packet:receive:SMSG_INITIALIZE_FACTIONS', (gp: any) => this.handleInitialize(gp));
    this.game.on('packet:receive:SMSG_SET_FACTION_STANDING', (gp: any) => this.handleStanding(gp));
    this.game.on('packet:receive:SMSG_SET_FACTION_VISIBLE', (gp: any) => this.handleVisible(gp));
    // A standing belongs to a character, not to a socket. Cleared on world entry for the reason
    // `World#clearRemoteEntities` is: a second login on the same page would otherwise show the previous
    // character's reputations until the server happened to resend them.
    this.game.on('packet:receive:SMSG_LOGIN_VERIFY_WORLD', () => this.reset());
  }

  reset(): void {
    if (this.standings.size === 0) {
      return;
    }
    this.standings.clear();
    this.revision += 1;
    this.announce();
  }

  /** Every known standing, keyed by `reputationIndex`. Read by `ui/reputation-bridge.ts`. */
  all(): Map<number, FactionStanding> {
    return this.standings;
  }

  get version(): number {
    return this.revision;
  }

  /**
   * `SMSG_INITIALIZE_FACTIONS` (0x122). See the header for the layout and its source.
   *
   * Wrapped the way `items.ts#handleQueryResponse` is wrapped, and for the same reason: `byte-buffer`
   * THROWS on a short read, and an uncaught throw here escapes `GameHandler#dataReceived` and takes every
   * packet still buffered in that data event with it. A layout whose only source is a server
   * implementation is a real candidate to be wrong, so this catch is not defensive decoration.
   */
  private handleInitialize(gp: any): void {
    try {
      const claimed = gp.readUnsignedInt() >>> 0;
      // The body is what is actually there; trust it over the declared count.
      const affordable = Math.floor(Math.max(0, gp.length - gp.index) / PAIR_BYTES);
      const count = Math.min(claimed, affordable, MAX_PAIRS);
      if (count !== claimed) {
        console.warn(
          `SMSG_INITIALIZE_FACTIONS: declared ${claimed} factions, reading ${count} `
          + `(${gp.length - gp.index} body bytes left)`,
        );
      }
      for (let index = 0; index < count; ++index) {
        const flags = gp.readUnsignedByte();
        // SIGNED: a standing runs from -42000 (Hated) to +42999 (Exalted), so an unsigned read would
        // turn every hostile faction into a ~4.29-billion friendly one.
        const standing = gp.readInt();
        this.standings.set(index, { flags, standing });
      }
      this.revision += 1;
      this.announce();
    } catch (error) {
      console.warn('SMSG_INITIALIZE_FACTIONS: decode failed', error);
    }
  }

  /**
   * `SMSG_SET_FACTION_STANDING` (0x124) -- one or more factions moved.
   *
   * Layout, same source as above: `float refer-a-friend bonus`, `uint8 sendFactionIncreased`, then
   * `uint32 count` and `count x { uint32 reputationIndex; uint32 standing }`. The leading float and flag
   * are 3.3.5 additions; reading them is what keeps the pairs aligned.
   */
  private handleStanding(gp: any): void {
    try {
      gp.readFloat(); // refer-a-friend bonus multiplier
      gp.readUnsignedByte(); // whether the client should show the "reputation increased" splash
      const count = Math.min(gp.readUnsignedInt() >>> 0, MAX_PAIRS);
      for (let i = 0; i < count; ++i) {
        const index = gp.readUnsignedInt() >>> 0;
        const standing = gp.readInt();
        const existing = this.standings.get(index);
        this.standings.set(index, {
          flags: existing?.flags ?? FACTION_FLAG_VISIBLE,
          standing,
        });
      }
      this.revision += 1;
      this.announce();
    } catch (error) {
      console.warn('SMSG_SET_FACTION_STANDING: decode failed', error);
    }
  }

  /** `SMSG_SET_FACTION_VISIBLE` (0x123) -- a single `uint32 reputationIndex` becomes visible. */
  private handleVisible(gp: any): void {
    try {
      const index = gp.readUnsignedInt() >>> 0;
      const existing = this.standings.get(index);
      this.standings.set(index, {
        flags: (existing?.flags ?? 0) | FACTION_FLAG_VISIBLE,
        standing: existing?.standing ?? 0,
      });
      this.revision += 1;
      this.announce();
    } catch (error) {
      console.warn('SMSG_SET_FACTION_VISIBLE: decode failed', error);
    }
  }

  /**
   * Tell whoever is listening. The bridge turns this into `UPDATE_FACTION`, which is the event
   * `ReputationFrame` itself registers for (`reputationframe.xml`).
   */
  private announce(): void {
    this.game.emit('reputation:change', this.revision);
  }
}

/** Named so a caller cannot pass the wrong opcode by accident. Referenced for the lint's benefit. */
export const REPUTATION_OPCODES = [
  GameOpcode.SMSG_INITIALIZE_FACTIONS,
  GameOpcode.SMSG_SET_FACTION_VISIBLE,
  GameOpcode.SMSG_SET_FACTION_STANDING,
];
