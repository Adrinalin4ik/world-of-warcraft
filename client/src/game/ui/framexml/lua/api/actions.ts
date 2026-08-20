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
   * The spell's RANK label (`Spell.dbc` `NameSubtext`, column 153) -- "Rank 3", "Passive" or `''`.
   *
   * Added for `GameTooltip:SetAction`, which draws it as line 1's RIGHT text the way the real client does.
   * Never null; `''` is the no-rank answer, the same contract `SpellbookEntry#subName` documents.
   */
  subName: string;
  /**
   * `Spell.dbc`'s `Description` (column 170, measured) -- the tooltip body, `$` tokens UNEXPANDED. `''`
   * until the 49 MB fetch lands. See `pipeline/dbc/spell-data.ts#COL.description`.
   */
  description: string;
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

  /**
   * `IsUsableAction`'s first return. False greys the icon to (0.4, 0.4, 0.4).
   *
   * "Usable" here means AFFORDABLE, and only that. The real client's `isUsable` also folds in form gating,
   * reagents, required equipment and required stance -- none of which this client evaluates -- so a spell
   * that is unaffordable is greyed and one that is merely form-gated is not. That is the honest half:
   * the half that IS computed is computed from the real numbers, and the half that is not leaves the
   * button bright rather than guessing it dark. See `ui/action-bridge.ts#usability` for the arithmetic.
   */
  usable: boolean;
  /**
   * `IsUsableAction`'s second return. Tints the icon (0.5, 0.5, 1.0) -- a washed BLUE, not red.
   *
   * Only meaningful when `usable` is false; `ActionButton_UpdateUsable` tests them in that order
   * (`actionbutton.lua:313-328`).
   */
  notEnoughPower: boolean;
  /**
   * `IsActionInRange`'s return: `null` (no range to speak of, or no target), `0` OUT of range, `1` in.
   *
   * The three are not interchangeable. `ActionButton_OnUpdate:461-488` hides the range indicator on
   * `nil`, paints it RED `(1.0, 0.1, 0.1)` on `0` and grey `(0.6, 0.6, 0.6)` on `1` -- so `nil` and `1`
   * differ in whether the dot is drawn at all, and returning `1` for "we do not know" would put a grey
   * dot on every button for ever.
   */
  inRange: number | null;
}

export function emptyAction(): ActionSnapshot {
  return {
    spellId: 0,
    texture: null,
    name: '',
    subName: '',
    description: '',
    isAttack: false,
    isCurrent: false,
    cooldownStart: 0,
    cooldownDuration: 0,
    // An EMPTY slot is usable and in no particular range. `ActionButton_Update` hides a button with no
    // action before either value is read, so these are the values that cannot cause a visible claim.
    usable: true,
    notEnoughPower: false,
    inRange: null,
  };
}

interface ActionState {
  slots: ActionSnapshot[];
  /** `CURRENT_ACTIONBAR_PAGE`'s engine half; `GetActionBarPage` answers it. 1-based. */
  page: number;
  /**
   * `GetBonusBarOffset()` -- which BONUS bar the player's shapeshift form has switched to, or 0.
   *
   * THE FIELD THAT DECIDES WHETHER A WARRIOR'S BAR HAS ANYTHING ON IT. `ActionButton_CalculateAction`
   * gives an `isBonus` button `page = NUM_ACTIONBAR_PAGES + offset` (`ActionButton.lua:139-144`), so
   * offset 1 makes `BonusActionButton1..12` read 1-based slots 73-84 -- which is exactly where the
   * server put this character's buttons (measured; see `ui/action-bridge.ts`). Written by the host from
   * the form byte and `SpellShapeshiftForm.dbc`; 0 with no host, which is "no bonus bar".
   */
  bonusBarOffset: number;
  /** What `UseAction` should do. Set by the host; a VM with no host casts nothing. */
  use: ((action: number) => void) | null;
  /**
   * `GetActionBarToggles`' five booleans: MultiBar 1-4 and `alwaysShowActionBars`.
   *
   * All false, which is what this client draws -- see `GetActionBarToggles` for why that is the true
   * answer and not a placeholder, and for the options-panel loop one nil global was aborting.
   */
  barToggles: [boolean, boolean, boolean, boolean, boolean];
}

/** Per-VM, because the glue and world runtimes can both be alive during a screen change. */
const stateByVm = new WeakMap<LuaVM, ActionState>();

function stateOf(vm: LuaVM): ActionState {
  let state = stateByVm.get(vm);
  if (state === undefined) {
    state = {
      slots: Array.from({ length: ACTION_SLOTS }, emptyAction),
      page: 1,
      bonusBarOffset: 0,
      use: null,
      barToggles: [false, false, false, false, false],
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

/**
 * THE push door for the bonus bar. Answers whether the value moved, so the host can fire
 * `UPDATE_BONUS_ACTIONBAR` only for a real change (see `action-bridge.ts` on why an event costs a
 * whole UI pass).
 */
export function setBonusBarOffset(vm: LuaVM, offset: number): boolean {
  const state = stateOf(vm);
  const next = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  if (state.bonusBarOffset === next) {
    return false;
  }
  state.bonusBarOffset = next;
  return true;
}

export function getBonusBarOffset(vm: LuaVM): number {
  return stateOf(vm).bonusBarOffset;
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

  /**
   * `GetBonusBarOffset()` -- the bonus bar the player's FORM has switched to, 0 for none.
   *
   * This answered a hard-coded 0 with the comment "there is no shapeshift feed in this client", and
   * that hard 0 was the whole reason the action bar looked empty: the server's action words for a
   * warrior sit in the bonus blocks (1-based slots 73-108), and with offset 0 no button ever addressed
   * them. There IS a feed now -- `UNIT_FIELD_BYTES_2` byte 3 through `SpellShapeshiftForm.dbc`
   * (`ui/action-bridge.ts`) -- so this reads what the host pushed.
   */
  fn('GetBonusBarOffset', () => [state.bonusBarOffset]);
  // The MULTI-CAST bar is a shaman's totem bar, which has no feed (`SMSG_MULTIPLE_...`/totem slots are
  // not decoded) and is not this character's bar in any case. Still 0, and still honest: 0 is "no
  // multi-cast bar active", which is true for every class but a shaman.
  fn('GetMultiCastBarOffset', () => [0]);

  /**
   * `GetActionBarToggles()` / `SetActionBarToggles(b1, b2, b3, b4, alwaysShow)` -- which extra bars are on.
   *
   * ONE MISSING GLOBAL WAS BLOCKING THE WHOLE ACTION-BARS OPTIONS PANEL, and with it the LOCKED-BARS
   * setting the shift-gated drag reads. `BlizzardOptionsPanel_OnEvent` walks a panel's controls on
   * `PLAYER_ENTERING_WORLD` and `securecall`s `BlizzardOptionsPanel_SetupControl` for each
   * (`optionspaneltemplates.lua:311-356`), and that is the ONLY thing that copies a CVar into its uvar
   * (`:373-380` -- `_G[control.uvar] = GetCVar(control.cvar)`). Four of the panel's seven controls declare
   * `self.GetValue = function () return self.value or ((select(N, GetActionBarToggles()) and "1") or "0"); end`
   * (`interfaceoptionspanels.xml:1385,1404,1423,1442`), and `securecall` here is a plain call
   * (`api/secure.ts:38-54`), so a nil global aborted the loop before it reached
   * `$parentLockActionBars`. MEASURED: firing the event by hand raised
   * `InterfaceOptionsPanels.xml:...:7: attempt to call a nil value (global 'GetActionBarToggles')` and
   * `LOCK_ACTIONBAR` stayed at its `"0"` default while `GetCVar("lockActionBars")` read `"1"`.
   *
   * ALL FOUR OFF is the true answer, not a placeholder: the real client MIRRORS these from the server
   * (`uiparent.lua:649` says so in as many words -- "the values GetActionBarToggles() returns are
   * incorrect if it's called before the client mirrors SetActionBarToggles values from the server") and
   * this client decodes no such field, so no multi-bar is fed, none is drawn, and `MultiActionBar_Update`
   * hiding all four is exactly what is on screen. `SetActionBarToggles` stores what the options panel
   * writes (`interfaceoptionspanels.lua:1193`) so a toggle within one session is not silently discarded;
   * it is NOT sent to the server, which is the stated gap -- the setting will not survive a relog.
   */
  fn('GetActionBarToggles', () => [
    state.barToggles[0], state.barToggles[1], state.barToggles[2], state.barToggles[3],
    state.barToggles[4],
  ]);
  fn('SetActionBarToggles', (args) => {
    for (let i = 0; i < 5; i += 1) {
      // FrameXML spells these as the STRING "1"/nil (the uvars it passes are uvar strings), so anything
      // truthy that is not the string "0" is on -- the same Lua-truthiness trap `SetChecked("false")` was.
      const raw = args[i];
      state.barToggles[i] = raw !== undefined && raw !== null && raw !== false && raw !== '0';
    }
    return [];
  });

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
  /**
   * `IsUsableAction(action)` -> `isUsable, notEnoughMana`.
   *
   * Both come from the host's snapshot, computed in `ui/action-bridge.ts#usability` from the player's
   * live power and the spell's cost. This was a declared gap returning a hard `true, false`, which
   * painted every ability at full brightness whatever the player could afford.
   *
   * An EMPTY slot answers `true, false` -- `ActionButton_Update` hides a button with no action before
   * ever calling this, so the values are unobservable and `true` is the one that asserts nothing.
   */
  fn('IsUsableAction', (args) => {
    const slot = slotOf(args[0]);
    if (slot === null || slot.spellId === 0) {
      return [true, false];
    }
    return [slot.usable, slot.notEnoughPower];
  });

  /**
   * `IsActionInRange(action)` -> `nil` / `0` / `1`. See `ActionSnapshot#inRange` on why the three differ.
   *
   * This was a declared gap returning a hard `nil`, which hid the range indicator on every button.
   */
  fn('IsActionInRange', (args) => [slotOf(args[0])?.inRange ?? null]);

  const gaps: Array<[string, string, unknown[]]> = [
    [
      // **THE FIRST STATEMENT OF EVERY RIGHT-CLICK ON A UNIT PORTRAIT, AND ITS ABSENCE WAS THE WHOLE
      // OF "правый клик не работает, совсем. Не появляется меню".**
      //
      // `SecureUnitButton_OnLoad` sets `*type2 = "menu"` (`SecureTemplates.lua:557`), so a right-click
      // on PlayerFrame/TargetFrame/PartyMemberFrame enters `SecureUnitButton_OnClick`, whose body opens:
      //
      //     local type = SecureButton_GetModifiedAttribute(self, "type", button);
      //     if ( type == "menu" ) then
      //         if ( SpellIsTargeting() ) then          -- SecureTemplates.lua:565
      //
      // MEASURED, not reasoned about -- the console line, from a separated right-click on PlayerFrame:
      //   `framexml: PlayerFrame: OnClick: [string "SecureTemplates.lua"]:565: attempt to call a nil
      //    value (global 'SpellIsTargeting')`
      // The handler died there, BEFORE `SecureActionButton_OnClick` ran, so `rawget(self, "menu")` was
      // never reached and no menu could ever appear.
      //
      // THIS IS ALSO THE ASYMMETRY WITH THE STAT DROPDOWNS, which DO open: their arrow is a plain
      // Button whose `OnClick` calls `ToggleDropDownMenu` directly (`paperdollframe.lua`), so it never
      // touches the secure-button path. The unit popup is the only menu in the client that does. It was
      // therefore neither the dropdown rect, nor `SetFrameLevel`, nor hit-testing -- all three of which
      // were fixed in neighbouring rounds and none of which was reached.
      //
      // `SpellCanTargetItem` below was declared for the TAIL of the same file's
      // `SecureActionButton_OnClick` (line 537) and by the same reasoning; this is its head. Both are
      // FALSE for the same true reason: nothing in this client puts the cursor into spell-targeting
      // mode, so a click is never awaiting a spell target.
      'SpellIsTargeting',
      'no spell-targeting cursor state exists in this client, so a click is never awaiting a spell '
        + 'target (SecureTemplates.lua:565, and SECURE_ACTIONS.target at :403)',
      [false],
    ],
    [
      // The TAIL of every action-button click: `SecureActionButton_OnClick:537` reads
      // `if ( SpellCanTargetItem() )` after it has dispatched the action, to route a spell that needs an
      // item target (an enchant, a poison) at a bag slot. Its absence raised on EVERY click -- measured,
      // `BonusActionButton2: OnClick: SecureTemplates.lua:537: attempt to call a nil value` -- after the
      // cast had already been dispatched, so it cost an error line rather than the cast. False is the
      // true answer for a click that is not awaiting an item target, which is every click here: nothing
      // in this client puts the cursor into spell-targeting mode.
      'SpellCanTargetItem',
      'no spell-targeting cursor state exists in this client, so a click is never awaiting an item '
        + 'target (SecureTemplates.lua:537)',
      [false],
    ],
    [
      // Called 10 times across `BonusActionBarFrame.lua`, `PetActionBarFrame.lua`, `MainMenuBar.lua`,
      // `UIParent.lua` and `FloatingChatFrame.lua`, and its absence was aborting
      // `ShapeshiftBar_OnLoad` outright (`BonusActionBarFrame.lua:126`). 0 means "this character has no
      // stance bar", which hides `ShapeshiftBarFrame` (`ShapeshiftBar_Update:145`) -- and that is the
      // honest answer: the player's CURRENT form is read (see `GetBonusBarOffset`), but the LIST of
      // forms a class has needs the known-spell set cross-referenced against `SpellShapeshiftForm.dbc`,
      // which is not done, and `GetShapeshiftFormInfo`/`GetShapeshiftFormCooldown` with it. So the
      // stance BUTTONS are absent rather than wrong.
      'GetNumShapeshiftForms',
      'no stance-bar feed: the current form is known but the list of a class\'s forms is not, so '
        + 'ShapeshiftBarFrame stays hidden and the three stance buttons are not drawn',
      [0],
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
