/**
 * The action-bar globals -- what `ActionButton.lua` asks the engine for, and nothing else.
 *
 * **This file contains no world, no network, no guids and no DBCs.** It holds a per-VM array of 144
 * snapshots that the host writes and the Lua reads, exactly as `api/units.ts` holds unit snapshots. The
 * seam that fills it is `ui/action-bridge.ts`; nothing here knows a spell id came off a wire.
 *
 * ## Which globals, and why exactly these
 *
 * Measured, not guessed: `Interface\FrameXML\ActionButton.lua` was read in full and every engine call it
 * makes is implemented or declared below. The click path was traced the same way --
 * `ActionBarButtonTemplate` inherits `SecureActionButtonTemplate` (`ActionBarFrame.xml:4`), whose
 * `<OnClick function="SecureActionButton_OnClick"/>` (`SecureTemplates.xml:13`) reaches
 * `SECURE_ACTIONS.action` (`SecureTemplates.lua:303-312`), which is:
 *
 *     local action = ActionButton_CalculateAction(self, button);
 *     if ( action ) then securecall("MacroFrame_SaveMacro"); UseAction(action, unit, button); end
 *
 * So a mouse click on an action button reaches exactly one engine global, `UseAction`, and that is the
 * one that has to cast. Note its real 3.3.5a signature as CALLED here is `(action, unit, button)` and not
 * the `(slot, checkCursor, onSelf)` the API documentation gives -- the arguments after the first are
 * ignored below, and the target comes from the host's own selection, which is what the server would use
 * anyway.
 *
 * ## What is deliberately a declared gap
 *
 * `IsActionInRange`, `IsUsableAction`'s resource half and the whole condition set on a button (range,
 * reagents, usability) were deferred by the owner to a later round, and a cast bar and a live global
 * cooldown with it. Each goes through `notImplemented` so the load report names it, because a silent
 * `true` here is precisely how a button renders plausibly and wrongly -- it would show every ability as
 * usable, in range and off cooldown.
 *
 * `GetActionCooldown` is NOT a gap: it answers from what the host pushed, which today is only what
 * `SMSG_INITIAL_SPELLS` reported (no active cooldowns on a fresh entry) since no per-cast cooldown feed
 * exists yet. It therefore answers `0, 0, 0` -- "no cooldown" -- honestly rather than by stubbing.
 */
import { LuaVM } from '../vm';
import { notImplemented } from '../methods/region';

/** 3.3.5a `MAX_ACTION_BUTTONS`: 12 buttons x 12 pages. */
export const ACTION_SLOTS = 144;

/** One action slot as the UI needs to see it. All fields are plain values -- no live objects. */
export interface ActionSnapshot {
  /** 0 means the slot is empty, and is what makes `HasAction` false. */
  spellId: number;
  /** The icon path, extensionless, e.g. `Interface\Icons\Spell_Fire_FlameBolt`. Null until resolved. */
  texture: string | null;
  name: string;
  /**
   * True for spell 6603 "Auto Attack" -- what `IsAttackAction` reports, and what makes the button
   * flash while swinging (`ActionButton_UpdateFlash`).
   */
  isAttack: boolean;
  /** True when this action is the one currently active: auto-attack running, for the attack button. */
  isCurrent: boolean;
  /** `GetActionCooldown`'s `start` and `duration`, in `GetTime()` seconds. Both 0 for no cooldown. */
  cooldownStart: number;
  cooldownDuration: number;
}

export function emptyAction(): ActionSnapshot {
  return {
    spellId: 0,
    texture: null,
    name: '',
    isAttack: false,
    isCurrent: false,
    cooldownStart: 0,
    cooldownDuration: 0,
  };
}

interface ActionState {
  slots: ActionSnapshot[];
  /** `CURRENT_ACTIONBAR_PAGE`'s engine half; `GetActionBarPage` answers it. 1-based. */
  page: number;
  /** What `UseAction` should do. Set by the host; a VM with no host casts nothing. */
  use: ((action: number) => void) | null;
}

/** Per-VM, because the glue and world runtimes can both be alive during a screen change. */
const stateByVm = new WeakMap<LuaVM, ActionState>();

function stateOf(vm: LuaVM): ActionState {
  let state = stateByVm.get(vm);
  if (state === undefined) {
    state = {
      slots: Array.from({ length: ACTION_SLOTS }, emptyAction),
      page: 1,
      use: null,
    };
    stateByVm.set(vm, state);
  }
  return state;
}

/**
 * THE push door, for one slot. `action` is Lua's 1-based slot number.
 *
 * The host pushes and THEN fires `ACTIONBAR_SLOT_CHANGED`, in that order, for the same reason
 * `unit-bridge.ts` does: every FrameXML handler re-reads through these globals the moment it runs, so
 * firing first hands the old snapshot to the handler for the new state.
 */
export function setAction(vm: LuaVM, action: number, snapshot: ActionSnapshot): void {
  if (action < 1 || action > ACTION_SLOTS) {
    return;
  }
  stateOf(vm).slots[action - 1] = snapshot;
}

export function getAction(vm: LuaVM, action: number): ActionSnapshot | null {
  if (action < 1 || action > ACTION_SLOTS) {
    return null;
  }
  return stateOf(vm).slots[action - 1] ?? null;
}

/** The host's cast door: what `UseAction` calls. */
export function setActionUseHandler(vm: LuaVM, use: (action: number) => void): void {
  stateOf(vm).use = use;
}

export function installActionsApi(vm: LuaVM): void {
  const state = stateOf(vm);

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  /** A slot argument, or null when it is not a usable slot number. FrameXML passes `self.action`. */
  const slotOf = (value: unknown): ActionSnapshot | null => {
    const action = Number(value);
    if (!Number.isFinite(action) || action < 1 || action > ACTION_SLOTS) {
      return null;
    }
    return state.slots[action - 1] ?? null;
  };

  // `HasAction` is what decides whether a button is SHOWN at all (`ActionButton_Update:171`), so an
  // empty slot answering true would draw 144 empty buttons and a filled one answering false would draw
  // none. Truthiness in Lua, so a plain boolean is right here.
  fn('HasAction', (args) => [(slotOf(args[0])?.spellId ?? 0) !== 0]);

  // nil, not "", for a slot with no resolved icon: `ActionButton_Update:245` branches on
  // `if ( texture )`, and an empty string is TRUTHY in Lua -- it would take the "has icon" branch and
  // call `icon:SetTexture("")`, showing an untextured white quad instead of hiding the icon.
  fn('GetActionTexture', (args) => [slotOf(args[0])?.texture ?? null]);

  // The MACRO name, not the spell name -- `ActionButton_Update:239` puts this under the icon, and the
  // real client shows nothing there for a spell. Answering the spell's name would caption every button.
  fn('GetActionText', () => ['']);

  fn('GetActionCount', () => [0]);
  fn('IsConsumableAction', () => [false]);
  fn('IsStackableAction', () => [false]);
  fn('IsEquippedAction', () => [false]);

  // The auto-attack button's CHECKED state and its flash. `IsCurrentAction` is also what a "current"
  // spell (an aimed shot being wound up) would use; only auto-attack drives it today.
  fn('IsCurrentAction', (args) => [slotOf(args[0])?.isCurrent ?? false]);
  fn('IsAttackAction', (args) => [slotOf(args[0])?.isAttack ?? false]);
  // Auto-SHOOT (a wand or a ranged auto-repeat), which is not auto-ATTACK and is not wired: there is no
  // `START_AUTOREPEAT_SPELL` feed. False rather than a stub because the answer for a melee character
  // with no wand is genuinely false, and `ActionButton_UpdateFlash` reads it every update.
  fn('IsAutoRepeatAction', () => [false]);

  /**
   * `GetActionCooldown(action)` -> `start, duration, enable`.
   *
   * `enable` is 1 whenever the slot holds something, which is the real client's meaning: it is "may this
   * frame show a cooldown at all", not "is one running". `CooldownFrame_SetTimer` requires all three of
   * `start > 0`, `duration > 0` and `enable > 0` before it shows anything (`Cooldown.lua`), so a slot
   * with no cooldown correctly shows nothing.
   */
  fn('GetActionCooldown', (args) => {
    const slot = slotOf(args[0]);
    if (slot === null || slot.spellId === 0) {
      return [0, 0, 0];
    }
    return [slot.cooldownStart, slot.cooldownDuration, 1];
  });

  /**
   * `UseAction(action, unit, button)` -- the whole click path's destination. See the header for the
   * trace, and note the argument shape is what `SECURE_ACTIONS.action` passes, not the documented one.
   *
   * The target is the host's current selection rather than the `unit` argument: `unit` is nil for an
   * ordinary action button (`SecureButton_GetModifiedUnit` returns nil without a `unit` attribute), and
   * the server resolves an untargeted cast against the caster's own selection regardless.
   */
  fn('UseAction', (args) => {
    const action = Number(args[0]);
    if (!Number.isFinite(action) || state.use === null) {
      return [];
    }
    state.use(action);
    return [];
  });

  // `GetActionBarPage`/`ChangeActionBarPage`: paging works entirely inside the client's own Lua
  // (`ActionButton_CalculateAction` multiplies the page by 12), so the engine half is just the number.
  // The page is NOT sent to the server -- in the real client it is a CVar, and `SMSG_ACTION_BUTTONS`
  // already delivered all 144 slots, so every page is already in hand.
  fn('GetActionBarPage', () => [state.page]);
  fn('ChangeActionBarPage', (args) => {
    const page = Number(args[0]);
    if (Number.isFinite(page) && page >= 1 && page <= 12) {
      state.page = page;
    }
    return [];
  });

  // Both are offsets into the BONUS bars -- a druid's forms, a rogue's stealth bar, a vehicle. There is
  // no shapeshift or vehicle feed in this client, so the honest answer is 0 (no bonus bar active), which
  // is also what `ActionButton_CalculateAction` needs to leave the page arithmetic alone.
  fn('GetBonusBarOffset', () => [0]);
  fn('GetMultiCastBarOffset', () => [0]);

  /**
   * Declared gaps. Each returns the value that makes the UI behave as if the feature is simply absent,
   * and each is registered by NAME so `NOT_IMPLEMENTED` and the load report carry it.
   *
   * `IsUsableAction` returning `true, false` is the one that deserves scepticism, and it is stated
   * rather than hidden: it paints every ability at full brightness whether or not it is affordable.
   * The alternative -- guessing from `Spell.dbc`'s `manaCost` against the player's power -- would be
   * wrong for every percentage-cost, rune, combo-point and form-gated spell in the build, and the owner
   * deferred the condition set explicitly. A grey icon that should be bright is a visible lie; a bright
   * icon on a build with no usability feed is a stated gap.
   */
  const gaps: Array<[string, string, unknown[]]> = [
    [
      'IsActionInRange',
      'no range feed: SpellRange.dbc is not read and there is no per-frame distance check, so the '
        + 'range indicator on a hotkey cannot be coloured (ActionButton_OnUpdate:467)',
      [null],
    ],
    [
      'IsUsableAction',
      'no usability feed: returns usable=true, notEnoughMana=false unconditionally, so an '
        + 'unaffordable or form-gated ability is drawn at full brightness (ActionButton_UpdateUsable)',
      [true, false],
    ],
    [
      'GetBindingKey',
      'no keybinding table in this client, so no hotkey text is drawn on a button',
      [null],
    ],
    [
      'GetBindingText',
      'no keybinding table in this client, so no hotkey text is drawn on a button',
      [''],
    ],
  ];

  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    // `notImplemented` builds a FRAME METHOD `(ctx, self, args)`; a global takes only args. The shapes
    // differ, so the stub is adapted rather than registered directly -- what is reused is the NAME
    // REGISTRATION, which is the part the load report reads. Same adaptation as `api/units.ts:474-480`.
    fn(name, () => stub(null as never, 0, []));
  }
}
