/**
 * THE KEY-BINDING GLOBALS -- what makes a key press reach the client's own Lua.
 *
 * Before this, only a pointer click could fire an action. The engine half of a key press is small and
 * entirely mechanical, and the important thing about it is what it does NOT do: it never touches an
 * action button, never knows a slot number, and never calls `UseAction`. It runs a named COMMAND's Lua
 * out of `Interface\FrameXML\Bindings.xml`, and that Lua -- `ActionButtonUp` -> the same
 * `SecureActionButton_OnClick` a mouse click reaches -- does all of it. See `framexml/bindings.ts` for
 * the document, the key tokens and the default assignments.
 *
 * ## The two directions, and which one FrameXML uses
 *
 *  - **key -> command**, which is `dispatch` below and is called by the input router. This is the live
 *    path; no Lua asks for it.
 *  - **command -> key**, which is `GetBindingKey(command)` and is what the UI draws.
 *    `ActionButton_UpdateHotkeys` (`actionbutton.lua:102-129`) is the caller that matters:
 *
 *        local key = GetBindingKey(actionButtonType..id) or
 *                    GetBindingKey("CLICK "..self:GetName()..":LeftButton");
 *        local text = GetBindingText(key, "KEY_", 1);
 *        if ( text == "" ) then hotkey:SetText(RANGE_INDICATOR); hotkey:Hide();
 *        else hotkey:SetText(text); hotkey:Show(); end
 *
 *    So the hotkey TEXT on a button and the key that FIRES it are the same table read two ways, and a
 *    binding table is why both were absent together. `RANGE_INDICATOR` is `"●"` -- a filled circle
 *    (`actionbutton.lua:10`) -- which is also the region the out-of-range colour is painted on, so this
 *    file is a prerequisite for the range indicator as well as for the hotkey.
 *
 * ## `GetBindingText`'s three arguments
 *
 * `GetBindingText(key, prefix, abbreviate)`. The `prefix` is `"KEY_"` and names the `GlobalStrings.lua`
 * entry to look the token up in: `KEY_BUTTON1 = "Left Mouse Button"` (`globalstrings.lua:4574`) is why
 * a mouse-bound command draws a word rather than `BUTTON1`. A token with no `KEY_` entry -- every digit,
 * every letter -- draws as itself, which is what makes `ACTIONBUTTON1` show `1`.
 *
 * `abbreviate` shortens the MODIFIER prefixes only. The unabbreviated words come from
 * `SHIFT_KEY_TEXT = "SHIFT"` / `CTRL_KEY_TEXT = "CTRL"` (`globalstrings.lua:6244`, `:1893`) and the
 * abbreviated forms are the client's single letters. Both are read out of the VM's own globals rather
 * than hard-coded here, so a localised build gets its own words for free.
 */
import { LuaVM } from '../vm';
import { BindingCommand } from '../../bindings';
import { notImplemented } from '../methods/region';

interface BindingState {
  /** `Bindings.xml`'s commands, in document order -- `GetBinding(index)` is 1-based over this. */
  commands: BindingCommand[];
  byName: Map<string, BindingCommand>;
  /** Key token -> command name. The live table `dispatch` reads. */
  keyToCommand: Map<string, string>;
  /**
   * Command name -> its key tokens, in binding order.
   *
   * A command may hold TWO keys in the real client (`GetBindingKey` returns up to two, and the Key
   * Bindings UI shows both), so this is an array and not a single token.
   */
  commandToKeys: Map<string, string[]>;
}

const stateByVm = new WeakMap<LuaVM, BindingState>();

function stateOf(vm: LuaVM): BindingState {
  let state = stateByVm.get(vm);
  if (state === undefined) {
    state = {
      commands: [],
      byName: new Map(),
      keyToCommand: new Map(),
      commandToKeys: new Map(),
    };
    stateByVm.set(vm, state);
  }
  return state;
}

/**
 * Publish the parsed `Bindings.xml` and an initial key assignment into a VM.
 *
 * Called by the host once the document is fetched. Assignments whose command is not in the document are
 * dropped rather than kept: a key bound to a command with no script is a key that silently does
 * nothing, and this is the one place that can tell the difference.
 */
export function setBindingTable(
  vm: LuaVM,
  commands: BindingCommand[],
  assignments: ReadonlyArray<readonly [string, string]>,
): void {
  const state = stateOf(vm);
  state.commands = commands;
  state.byName = new Map(commands.map((command) => [command.name, command]));
  state.keyToCommand = new Map();
  state.commandToKeys = new Map();
  for (const [command, key] of assignments) {
    if (!state.byName.has(command)) {
      continue;
    }
    bind(state, key, command);
  }
}

/** `SetBinding`'s core, shared with the initial load. A key holds exactly one command. */
function bind(state: BindingState, key: string, command: string | null): void {
  const previous = state.keyToCommand.get(key);
  if (previous !== undefined) {
    const keys = state.commandToKeys.get(previous);
    if (keys !== undefined) {
      const rest = keys.filter((k) => k !== key);
      if (rest.length === 0) {
        state.commandToKeys.delete(previous);
      } else {
        state.commandToKeys.set(previous, rest);
      }
    }
    state.keyToCommand.delete(key);
  }
  if (command === null) {
    return;
  }
  state.keyToCommand.set(key, command);
  const keys = state.commandToKeys.get(command) ?? [];
  keys.push(key);
  state.commandToKeys.set(command, keys);
}

/**
 * THE LIVE PATH: run whatever `key` is bound to. Returns true when a command was found and run, which
 * is what tells the input router to swallow the browser's own handling of the key.
 *
 * `keystate` is `"down"` or `"up"`, and a command that did not ask for `runOnUp` is not run on the
 * release at all -- that is the attribute's whole meaning and skipping the check would fire every
 * binding twice. Every `ACTIONBUTTON` command DOES ask for it, and needs to: `ActionButtonDown` only
 * pushes the button in and `ActionButtonUp` is what casts (`framexml/bindings.ts`).
 */
export function dispatchBinding(vm: LuaVM, key: string, down: boolean): boolean {
  const state = stateOf(vm);
  const name = state.keyToCommand.get(key);
  if (name === undefined) {
    return false;
  }
  const command = state.byName.get(name);
  if (command === undefined) {
    return false;
  }
  if (!down && !command.runOnUp) {
    // Bound, and deliberately silent on the release. Still "handled" -- the press was ours, so the
    // release is too, and letting it through would give the browser half a key event.
    return true;
  }
  // `keystate` is the local the script's own first line tests. Injected as a `local` on ONE line with
  // the chunk's own first line rather than as a global: a global would outlive the call and be readable
  // by anything that ran next, and the client's own binding scripts only ever read it immediately.
  // The cost is that a Lua error inside a binding reports its line one lower than `Bindings.xml`'s --
  // the chunk name below says which command it was, which is what a report needs.
  const source = `local keystate = ${down ? '"down"' : '"up"'}; ${command.script}`;
  const error = vm.run(source, `Bindings.xml:${name}`);
  if (error !== null) {
    console.warn(`binding ${name} (${key}, ${down ? 'down' : 'up'}): ${error.message}`);
  }
  return true;
}

export function installBindingsApi(vm: LuaVM): void {
  const state = stateOf(vm);
  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  /**
   * `GetBindingKey(command)` -> up to two key tokens, or nil.
   *
   * nil and not `""` for an unbound command: `ActionButton_UpdateHotkeys` writes
   * `GetBindingKey(a) or GetBindingKey(b)`, and `""` is TRUTHY in Lua -- it would take the first branch
   * and never try the `CLICK` form.
   */
  fn('GetBindingKey', (args) => {
    const keys = state.commandToKeys.get(String(args[0] ?? '')) ?? [];
    return keys.length === 0 ? [null] : [keys[0] ?? null, keys[1] ?? null];
  });

  /** `GetBindingByKey(key)` / `GetBindingAction(key)` -> the command a key holds, or nil. */
  const commandForKey = (args: unknown[]): unknown[] => [
    state.keyToCommand.get(String(args[0] ?? '')) ?? null,
  ];
  fn('GetBindingByKey', commandForKey);
  fn('GetBindingAction', commandForKey);

  /**
   * `GetBindingText(key, prefix, abbreviate)` -> what to DRAW for a key token.
   *
   * `""` for a nil key, which is precisely what `ActionButton_UpdateHotkeys` tests for before falling
   * back to the range indicator. See the header for where `prefix` and `abbreviate` come from.
   */
  fn('GetBindingText', (args) => {
    const key = args[0];
    if (typeof key !== 'string' || key === '') {
      return [''];
    }
    const prefix = typeof args[1] === 'string' ? args[1] : '';
    const abbreviate = args[2] !== undefined && args[2] !== null && args[2] !== false;

    // Peel the modifier prefixes off in the order `keyToken` puts them on.
    let rest = key;
    const mods: string[] = [];
    for (const [token, word, short] of MODIFIERS) {
      if (rest.startsWith(`${token}-`)) {
        rest = rest.slice(token.length + 1);
        const localized = vm.getGlobal(`${token}_KEY_TEXT`);
        mods.push(abbreviate ? short : (typeof localized === 'string' ? localized : word));
      }
    }

    // `KEY_<token>` out of `GlobalStrings.lua`, or the token itself. Read from the VM's globals so a
    // localised `GlobalStrings.lua` supplies its own words -- and so this does not carry a second copy
    // of a table the client already loaded.
    let base = rest;
    if (prefix !== '') {
      const named = vm.getGlobal(`${prefix}${rest}`);
      if (typeof named === 'string' && named !== '') {
        base = named;
      }
    }
    return [[...mods, base].join('-')];
  });

  /**
   * `SetBinding(key, command)` -> true. A nil/absent command CLEARS the key, which is how the Key
   * Bindings UI unbinds.
   */
  fn('SetBinding', (args) => {
    const key = String(args[0] ?? '');
    if (key === '') {
      return [false];
    }
    const command = args[1];
    bind(state, key, typeof command === 'string' && command !== '' ? command : null);
    return [true];
  });

  /**
   * `SetBindingClick(key, frameName, mouseButton)` -> a `CLICK <frame>:<button>` pseudo-command.
   *
   * The command name is synthesised, not looked up, because that is what it is in the real client: a
   * `CLICK` binding has no `<Binding>` element and the engine clicks the named frame directly. So it is
   * registered as a command whose SCRIPT is the click, written in Lua -- which keeps the rule that a key
   * press runs the client's own code and not ours. `ActionButton_UpdateHotkeys`'s second
   * `GetBindingKey("CLICK "..self:GetName()..":LeftButton")` is what reads it back.
   */
  fn('SetBindingClick', (args) => {
    const key = String(args[0] ?? '');
    const frame = String(args[1] ?? '');
    const button = String(args[2] ?? 'LeftButton');
    if (key === '' || frame === '') {
      return [false];
    }
    const name = `CLICK ${frame}:${button}`;
    if (!state.byName.has(name)) {
      state.commands.push({
        name,
        runOnUp: true,
        script: `if ( keystate == "up" ) then local f = _G["${frame}"]; if ( f and f.Click ) then f:Click("${button}"); end end`,
        header: null,
      });
      state.byName.set(name, state.commands[state.commands.length - 1]);
    }
    bind(state, key, name);
    return [true];
  });

  /** `GetNumBindings()` / `GetBinding(index)`: what the Key Bindings UI enumerates. 1-based. */
  fn('GetNumBindings', () => [state.commands.length]);
  fn('GetBinding', (args) => {
    const index = Number(args[0]);
    const command = Number.isFinite(index) ? state.commands[index - 1] : undefined;
    if (command === undefined) {
      return [null];
    }
    const keys = state.commandToKeys.get(command.name) ?? [];
    // `action, category, key1, key2` -- the shape `KeyBindingFrame.lua` unpacks.
    return [command.name, command.header ?? '', keys[0] ?? null, keys[1] ?? null];
  });

  /**
   * `RunBinding(command, keystate)`: fire a command by NAME. Called 15 times across the manifest, all of
   * them from a mouse-driven UI element standing in for a key (the `Bindings.xml`-declared bindings on
   * the interface panels).
   */
  fn('RunBinding', (args) => {
    const name = String(args[0] ?? '');
    const command = state.byName.get(name);
    if (command === undefined) {
      return [];
    }
    const down = args[1] === undefined || args[1] === null || String(args[1]) === 'down';
    const source = `local keystate = ${down ? '"down"' : '"up"'}; ${command.script}`;
    const error = vm.run(source, `Bindings.xml:${name}`);
    if (error !== null) {
      console.warn(`RunBinding ${name}: ${error.message}`);
    }
    return [];
  });

  /**
   * `GetCurrentBindingSet()` -> 1 for the account set, 2 for the per-character set.
   *
   * 1 is the true answer and not a stub: there is no per-character binding file in this client at all,
   * so the set in force IS the account one.
   */
  fn('GetCurrentBindingSet', () => [1]);

  /**
   * Declared gaps. `SaveBindings` is the sharp one -- a binding change is real for the session and lost
   * on reload, and a silent success would make that look like persistence.
   */
  const gaps: Array<[string, string, unknown[]]> = [
    [
      'SaveBindings',
      'no binding file is written: there is no WTF directory to persist to (the asset host serves no '
        + 'bindings-cache.wtf -- probed, 404), so a rebound key lives for the session only',
      [],
    ],
    [
      'LoadBindings',
      'no binding file is read: the table comes from Bindings.xml plus the built-in default '
        + 'assignments in framexml/bindings.ts, and there is no saved set to reload over them',
      [],
    ],
    [
      'SetBindingSpell',
      'no spell-by-name binding: this needs the known-spell set indexed by name, which the spellbook '
        + 'feed does not build (SpellBookFrame.lua drag-to-bind)',
      [false],
    ],
  ];
  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    // `notImplemented` builds a FRAME METHOD `(ctx, self, args)` and these are globals; the NAME
    // registration is what the load report reads. Same adaptation as `api/actions.ts:322-328`.
    fn(name, () => stub(null as never, 0, []));
  }
}

/**
 * The modifier tokens, their unabbreviated global name and the client's abbreviation.
 *
 * Order matches `bindings.ts#keyToken`'s prefix order (`ALT-CTRL-SHIFT-`), so peeling them off in this
 * order consumes the whole prefix.
 */
const MODIFIERS: ReadonlyArray<readonly [string, string, string]> = [
  ['ALT', 'ALT', 'a'],
  ['CTRL', 'CTRL', 'c'],
  ['SHIFT', 'SHIFT', 's'],
];
