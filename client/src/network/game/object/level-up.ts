/**
 * LEVELLING UP -- `SMSG_LEVELUP_INFO`, and what 3.3.5a actually does when it lands.
 *
 * Nothing here draws. This is the wire half; `game/ui/level-up-bridge.ts` fires the client's own event
 * and plays the effect.
 *
 * ## WHAT THE REAL CLIENT'S LEVEL-UP IS, and the source for each part
 *
 * Three things, and only one of them is a frame:
 *
 *  1. **The chat lines.** `chatframe.lua:2562-2601` handles `PLAYER_LEVEL_UP` and writes
 *     `LEVEL_UP` ("Congratulations, you have reached level %d!", `globalstrings.lua:4714`), then
 *     `LEVEL_UP_HEALTH_MANA` or `LEVEL_UP_HEALTH`, then `LEVEL_UP_CHAR_POINTS`, then one
 *     `LEVEL_UP_STAT` per stat that moved. That is the client's own Lua and this file's only job
 *     towards it is the nine event arguments.
 *  2. **The visual on the character.** `SpellVisualEffectName.dbc` **row 21** is named literally
 *     `HARDCODED Unit Level Up` and its model column is `Spells\LevelUp\LevelUp.mdl`. "HARDCODED"
 *     is the game's own label for an effect the engine plays itself rather than through a spell, and
 *     it is the same convention the neighbouring rows use for the loot sparkle (row 14, `HARDCODED
 *     Loot Art`) and the mount poof (row 1185). The served host answers
 *     `spells/levelup/levelup.m2` **200, 18256 bytes** with `levelup00.skin` **200, 1248 bytes**, so
 *     the model exists and is fetchable. **This is the effect, not an invented one** -- and it is
 *     also the reason there is no `LevelUpDisplay` frame to look for: the golden-banner frame is
 *     Cataclysm's, and grepping the whole 3.3.5a manifest for `PLAYER_LEVEL_UP` finds exactly two
 *     consumers, `chatframe.lua` and `MainMenuBar.lua:304` (which only refreshes the XP bar).
 *  3. **The sound.** `sound/interface/levelup.wav` answers **200, 192530 bytes** on the served host.
 *
 * There is nothing else. No screen flash, no frame, no cast bar -- so anything more than these three
 * would be an invention, which is what this round was told not to do.
 *
 * ## THE LAYOUT
 *
 * TrinityCore 3.3.5 `Player::GiveLevel` -- a SERVER implementation, labelled as such like every other
 * layout in this directory:
 *
 *     u32 level
 *     u32 healthGain
 *     5 x u32 powerGain      -- MAX_POWERS is 5 here: mana, rage, focus, energy, happiness
 *     5 x u32 statGain       -- MAX_STATS: strength, agility, stamina, intellect, spirit
 *
 * 48 bytes, fixed, no strings -- which makes this the one packet in the round with no `readCStr`
 * hazard and a residual that is either 0 or obviously wrong.
 *
 * **`MANA` IS POWER INDEX 0** and that is the only one the chat line uses: `LEVEL_UP_HEALTH_MANA`
 * takes `arg3`, which the client reads as the mana gain. The other four are written and ignored by
 * the real client too.
 *
 * **`arg4`, THE TALENT POINTS, IS A DECLARED GAP AND IS NOT IN THIS PACKET.** The client's own
 * `LEVEL_UP_CHAR_POINTS` line is gated on `arg4 > 0` (`chatframe.lua:2576`), so answering 0 omits
 * that one line and prints every other. The real engine derives it, and nothing this client reads
 * states the derivation: `player_character_points1` does arrive in the descriptor, but it arrives in
 * a SEPARATE packet with no ordering guarantee against this one, so differencing it here would be a
 * race rather than a source. Said plainly rather than approximated -- and note that below level 10
 * there are no talent points to gain at all, so the omitted line is also the correct line for the
 * levels this is most likely to be seen at.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GamePacket from '../packet';
import { itemWire } from '../../../game/classes/item-wire';

/** `MAX_POWERS` on 3.3.5a's level-up packet -- mana, rage, focus, energy, happiness. */
export const LEVEL_UP_POWER_COUNT = 5;

/** `MAX_STATS` -- strength, agility, stamina, intellect, spirit, in `UnitStat`'s own index order. */
export const LEVEL_UP_STAT_COUNT = 5;

export interface LevelUpInfo {
  level: number;
  healthGain: number;
  /** Five, in power-index order. Index 0 is MANA -- the only one the chat line uses. */
  powerGain: number[];
  /** Five, in `UnitStat` order, matching `SPELL_STAT1_NAME`..`SPELL_STAT5_NAME`. */
  statGain: number[];
}

export class LevelUpHandler extends EventEmitter {
  private game: GameHandler;

  /** The last level-up, for the instrument and for a bridge attached after the packet landed. */
  public last: LevelUpInfo | null = null;

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on('packet:receive:SMSG_LEVELUP_INFO', (gp: GamePacket) => {
      const bodySize = gp.bodySize;
      try {
        const info = this.decode(gp);
        this.last = info;
        itemWire.record({
          at: performance.now(),
          opcode: 'SMSG_LEVELUP_INFO',
          entry: info.level,
          name: '',
          bodySize,
          consumed: gp.index - gp.headerSize,
        });
        this.emit('levelUp', info);
      } catch (e) {
        itemWire.record({
          at: performance.now(),
          opcode: 'SMSG_LEVELUP_INFO!THREW',
          entry: 0,
          name: '',
          bodySize,
          consumed: gp.index - gp.headerSize,
        });
        console.warn(`levelUp: SMSG_LEVELUP_INFO did not decode -- ${(e as Error).message}.`);
      }
    });
  }

  private decode(gp: GamePacket): LevelUpInfo {
    const level = gp.readUnsignedInt() >>> 0;
    // SIGNED read then coerced: the server writes `int32(basehp) - int32(GetCreateHealth())`, which is
    // a difference and can in principle be negative. `readInt` keeps that honest; a negative gain would
    // print with its sign rather than as four billion hit points.
    const healthGain = gp.readInt();
    const powerGain: number[] = [];
    for (let i = 0; i < LEVEL_UP_POWER_COUNT; ++i) {
      powerGain.push(gp.readInt());
    }
    const statGain: number[] = [];
    for (let i = 0; i < LEVEL_UP_STAT_COUNT; ++i) {
      statGain.push(gp.readInt());
    }
    return { level, healthGain, powerGain, statGain };
  }
}

export default LevelUpHandler;
