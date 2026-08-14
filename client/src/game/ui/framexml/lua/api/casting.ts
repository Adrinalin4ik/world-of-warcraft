/**
 * THE CAST BAR's engine half -- `UnitCastingInfo` and `UnitChannelInfo`, and nothing else.
 *
 * `CastingBarFrame` was correctly hidden because these two globals did not exist. The frame is entirely
 * self-driving once they do: `CastingBarFrame_OnLoad` registers eleven `UNIT_SPELLCAST_*` events and
 * `CastingBarFrame_OnEvent` reads everything it draws out of `UnitCastingInfo(unit)`
 * (`castingbarframe.lua:44-118`). So what this client owed was a snapshot and the events, NOT a frame --
 * and driving the frame's status bar directly from TypeScript would have been the exact thing
 * `CLAUDE.md`'s first rule forbids.
 *
 * ## The return shape, and the millisecond trap in it
 *
 *     name, nameSubtext, text, texture, startTime, endTime, isTradeSkill, castID, notInterruptible
 *
 * `startTime` and `endTime` are in **MILLISECONDS**, on the `GetTime()` clock, and the frame divides:
 *
 *     self.value    = (GetTime() - (startTime / 1000));      castingbarframe.lua:85
 *     self.maxValue = (endTime - startTime) / 1000;          castingbarframe.lua:86
 *
 * Everything else in this runtime that carries a `GetTime()` stamp -- a cooldown's `start`, `GetTime()`
 * itself -- is in SECONDS. Handing these two seconds would put `value` a thousandfold in the past and
 * `maxValue` at a thousandth of the cast, so the bar would sit pinned full and never move. That is the
 * kind of failure that looks like a layout bug, so it is worth naming here: **this pair is milliseconds
 * and it is the only pair that is.**
 *
 * ## Why a table of its own rather than a field on `UnitSnapshot`
 *
 * A cast has a different LIFETIME from a unit snapshot. `unit-bridge.ts` rebuilds and re-pushes a whole
 * snapshot whenever any update field moves -- health ticking during a cast would do it -- and a cast
 * carried inside that object would be wiped by the next health change unless every push remembered to
 * copy it forward. Separate tables cannot have that bug.
 */
import { LuaVM } from '../vm';
import { notImplemented } from '../methods/region';

/** One unit's in-progress cast, as `UnitCastingInfo` has to report it. */
export interface CastSnapshot {
  /** The spell's name from `Spell.dbc`. `nil` here is what makes the frame hide itself. */
  name: string;
  /**
   * The spell id. Not part of `UnitCastingInfo`'s return shape -- it is here because
   * `CMSG_CANCEL_CAST` names the spell it is cancelling, and this snapshot is the only record of
   * which cast is in flight. See `ui/target-bridge.ts#SpellStopCasting`.
   */
  spellId: number;
  /** The icon path, or null. `CastingBarFrame`'s own `Icon` region is hidden at load, so this is unused
   * by the default bar and is carried because `UnitCastingInfo`'s contract has it and addons read it. */
  texture: string | null;
  /** `GetTime()` MILLISECONDS -- see the header. */
  startTimeMs: number;
  endTimeMs: number;
  /** The server's `castCount`, echoed back as `castID`: `UNIT_SPELLCAST_STOP`'s 4th arg is matched on it. */
  castID: number;
  /** A channel rather than a cast: `UnitChannelInfo` answers, `UnitCastingInfo` does not. */
  channeling: boolean;
  notInterruptible: boolean;
}

const stateByVm = new WeakMap<LuaVM, Map<string, CastSnapshot>>();

function castsOf(vm: LuaVM): Map<string, CastSnapshot> {
  let casts = stateByVm.get(vm);
  if (casts === undefined) {
    casts = new Map();
    stateByVm.set(vm, casts);
  }
  return casts;
}

/**
 * THE push door. `null` ends the cast.
 *
 * Push, then fire the event -- the same rule `unit-bridge.ts` and `action-bridge.ts` state: every
 * FrameXML handler re-reads through `UnitCastingInfo` the moment it runs, so firing first would hand the
 * OLD cast to the handler for the new one. `CastingBarFrame_OnEvent`'s `UNIT_SPELLCAST_START` branch
 * hides the frame outright when `UnitCastingInfo` answers no name, so the order is not cosmetic here.
 */
export function setCast(vm: LuaVM, token: string, cast: CastSnapshot | null): void {
  const casts = castsOf(vm);
  if (cast === null) {
    casts.delete(token);
  } else {
    casts.set(token, cast);
  }
}

export function getCast(vm: LuaVM, token: string): CastSnapshot | null {
  return castsOf(vm).get(token) ?? null;
}

export function installCastingApi(vm: LuaVM): void {
  const casts = castsOf(vm);
  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  /**
   * The nine values, or a single nil.
   *
   * ONE nil and not nine: `CastingBarFrame_OnEvent` writes `local name, nameSubtext, ... =
   * UnitCastingInfo(unit)` and then tests `if ( not name )`, so a single nil is sufficient and is what
   * the engine returns. `nameSubtext` is the spell's RANK in the real client and is left empty -- the
   * default bar never draws it (it draws `text`, the third value).
   */
  const report = (channeling: boolean) => (args: unknown[]): unknown[] => {
    const token = args[0];
    if (typeof token !== 'string') {
      return [null];
    }
    const cast = casts.get(token);
    if (cast === undefined || cast.channeling !== channeling) {
      return [null];
    }
    return [
      cast.name,
      '',
      cast.name,
      cast.texture,
      cast.startTimeMs,
      cast.endTimeMs,
      // `isTradeSkill`. False, and true rather than stubbed: a trade skill cast arrives through
      // `SMSG_SPELL_START` like any other and nothing here distinguishes one, but `CastingBarFrame` is
      // constructed with `showTradeSkills` TRUE for the player's own bar (`castingbarframe.xml`), so the
      // value does not gate anything the player can see.
      false,
      cast.castID,
      cast.notInterruptible,
    ];
  };

  fn('UnitCastingInfo', report(false));
  fn('UnitChannelInfo', report(true));

  /**
   * CHANNELLING is a declared gap, and it is declared rather than approximated because a channel is not a
   * cast with a different label -- the bar runs the OTHER WAY.
   * `CastingBarFrame_OnEvent`'s `UNIT_SPELLCAST_CHANNEL_START` branch sets
   * `value = endTime/1000 - GetTime()` and `OnUpdate` then DECREMENTS it (`castingbarframe.lua:191`,
   * `:255-262`), so the bar drains instead of filling, and it is green rather than orange.
   *
   * What is missing is the feed, not the frame: a channel arrives on `MSG_CHANNEL_START` (0x139) and
   * `MSG_CHANNEL_UPDATE` (0x13A), neither of which is decoded. `UnitChannelInfo` above is real and will
   * answer correctly the moment something pushes a `channeling: true` snapshot -- nothing does. So a
   * channelled spell currently shows NO bar at all, which is the honest outcome: letting it through the
   * cast path would draw a filling orange bar for something that should be a draining green one.
   *
   * Registered by NAME so the load report carries it. There is no method or global called
   * `UnitChannelInfo:feed`; this reuses `notImplemented`'s name registration exactly as
   * `api/actions.ts:322-328` and `api/units.ts:474-480` do.
   */
  notImplemented(
    'UNIT_SPELLCAST_CHANNEL_START',
    'channelled spells are not fed: MSG_CHANNEL_START (0x139) and MSG_CHANNEL_UPDATE (0x13A) are not '
      + 'decoded, so a channel shows no cast bar rather than a wrong one (it would drain, not fill)',
  );

  // `SpellStopCasting` USED TO BE DECLARED HERE and is now real -- it sends `CMSG_CANCEL_CAST` and is
  // the leg that makes Escape cancel a cast (`uiparent.lua:2893`). It needs a `World` to reach the
  // wire, which this installer does not have, so it lives in `ui/target-bridge.ts` with the other
  // selection globals. Named here because this is where a reader looks for it.
}
