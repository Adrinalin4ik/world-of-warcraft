/**
 * THE LEVEL-UP -- `PLAYER_LEVEL_UP`, and the burst on the character.
 *
 * Nothing is drawn here and there is no frame to draw: 3.3.5a has **no level-up frame at all**.
 * `LevelUpDisplay` is Cataclysm's. Grepping the whole 3.3.5a FrameXML mirror for `PLAYER_LEVEL_UP`
 * finds exactly two consumers -- `chatframe.lua:2562-2601`, which prints the congratulation and the
 * gains, and `MainMenuBar.lua:304-309`, which refreshes the XP bar. So the client's own Lua IS the
 * whole interface half of a level-up, and this file's job is the nine event arguments plus the world
 * effect the engine plays itself.
 *
 * ## THE NINE ARGUMENTS, in the client's own order
 *
 * `ChatFrame_SystemEventHandler` destructures them (`chatframe.lua:2563`):
 *
 *     arg1  new level                      -> LEVEL_UP              "Congratulations, you have reached level %d!"
 *     arg2  hit points gained              -> LEVEL_UP_HEALTH       "You have gained %d hit points."
 *     arg3  mana gained                    -> LEVEL_UP_HEALTH_MANA  when > 0, replaces the line above
 *     arg4  talent points gained           -> LEVEL_UP_CHAR_POINTS  when > 0
 *     arg5..arg9  strength, agility, stamina, intellect, spirit
 *                                          -> LEVEL_UP_STAT         one line each, when > 0
 *
 * Every one of the last six is gated on `> 0`, so a zero is a SKIPPED LINE and not a wrong one -- which
 * is why `arg4` being a declared gap (see `network/game/object/level-up.ts`) costs one absent line and
 * nothing else. **Getting arg2 and arg3 the wrong way round would be silent and wrong**: a mana class
 * would read "You have gained <mana> hit points and <hp> mana", both plausible numbers.
 *
 * `arg3 > 0` is also what selects between the two health strings, so a warrior -- who gains no mana --
 * correctly gets the one-number line.
 *
 * ## THE BURST is the game's own model, and the DBC names it
 *
 * `SpellVisualEffectName.dbc` row 21, `HARDCODED Unit Level Up`, `Spells\LevelUp\LevelUp.mdl`. The
 * whole source trail, including the served byte counts, is in `world/level-up-effect.ts`. It is played
 * from here rather than from the world loop because the packet arrives on the session's socket, not in
 * a frame.
 *
 * **The SOUND is the one part not built and it is not silently absent**: `sound/interface/levelup.wav`
 * is served (200 / 192,530 bytes) and this client has no audio engine at all -- every `PlaySound` in
 * `framexml/lua/api/sound.ts` is a no-op, by that file's own statement. Starting a mixer is a subsystem
 * and not a line, so it is named here as the remaining third of a 3.3.5a level-up.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import type { LevelUpHandler, LevelUpInfo } from '../../network/game/object/level-up';

export function attachLevelUpBridge(vm: LuaVM, world: World): () => void {
  const handler: LevelUpHandler = world.game.objectHandler.levelUpHandler;

  let disposed = false;

  const onLevelUp = (info: LevelUpInfo): void => {
    if (disposed) {
      return;
    }
    // THE BURST FIRST, so a Lua error in one of the client's own chat handlers cannot cost the effect.
    // `map` is null before a world exists; the effect then loads nothing rather than throwing.
    world.levelUpEffect.play(
      world.player.position,
      (world.map as unknown as { particleManager?: never } | null)?.particleManager ?? null,
    );
    fireEvent(vm, 'PLAYER_LEVEL_UP', [
      info.level,
      info.healthGain,
      // MANA is power index 0 -- see `level-up.ts`. The other four powers are written by the server and
      // ignored by the real client too.
      info.powerGain[0] ?? 0,
      // arg4, the talent points. A DECLARED GAP: it is not in this packet and differencing the
      // descriptor's `player_character_points1` against it would be a race, not a source. See
      // `level-up.ts`' header. 0 omits `LEVEL_UP_CHAR_POINTS` and prints every other line.
      0,
      info.statGain[0] ?? 0,
      info.statGain[1] ?? 0,
      info.statGain[2] ?? 0,
      info.statGain[3] ?? 0,
      info.statGain[4] ?? 0,
    ]);
    // The XP bar's own refresh. `MainMenuBar_UpdateExperienceBars` is registered for `PLAYER_LEVEL_UP`
    // itself (`MainMenuBar.lua:304`), so this is NOT fired here -- a second event would repaint the bar
    // twice and dirty the offscreen UI target for nothing.
  };

  handler.on('levelUp', onLevelUp);

  return () => {
    disposed = true;
    handler.off('levelUp', onLevelUp);
  };
}

export default attachLevelUpBridge;
