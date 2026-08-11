/**
 * THE KEY PATH, end to end: a `<Bindings>` document, a key token, and the Lua a press runs.
 *
 * One test, happy path, covering the seam that the whole of "hotkeys do not work" was: parse the
 * document, assign `1` to `ACTIONBUTTON1`, press `Digit1`, and check the binding's own Lua ran with
 * `keystate` set. If any link in that chain breaks the button is unreachable from the keyboard, and
 * nothing else in the suite touches it.
 *
 * The shifted case is in here too because it is the one thing `event.key` would get wrong: `event.key`
 * for Digit1 with shift held is `"!"`, so a token built from it would look up a command bound to `"!"`
 * and find nothing. `keyToken` reads `event.code` for exactly that reason.
 */
import { keyToken, parseBindings } from '../bindings';
import { LuaVM } from '../lua/vm';
import { dispatchBinding, installBindingsApi, setBindingTable } from '../lua/api/bindings';

/** Two commands out of the real document's shape, including the `runOnUp` every ACTIONBUTTON carries. */
const DOCUMENT = `<Bindings>
  <Binding name="ACTIONBUTTON1" runOnUp="true" header="ACTIONBAR">
    if ( keystate == "down" ) then
      PRESSED = "down";
    else
      PRESSED = "up";
    end
  </Binding>
  <Binding name="TOGGLESPELLBOOK">
    OPENED = 1;
  </Binding>
</Bindings>`;

/** A `KeyboardEvent`-shaped object. `keyToken` reads `code` and the three modifier flags, nothing else. */
const press = (code: string, shift = false): KeyboardEvent => ({
  code,
  shiftKey: shift,
  ctrlKey: false,
  altKey: false,
} as KeyboardEvent);

test('a bound key runs its Bindings.xml command with keystate, and GetBindingKey reports it back', () => {
  const commands = parseBindings(DOCUMENT);
  expect(commands.map((c) => c.name)).toEqual(['ACTIONBUTTON1', 'TOGGLESPELLBOOK']);
  // `runOnUp` is what makes the RELEASE run at all, and the release is where an action button casts.
  expect(commands[0].runOnUp).toBe(true);
  expect(commands[1].runOnUp).toBe(false);
  expect(commands[0].header).toBe('ACTIONBAR');

  // `event.code`, not `event.key`: with shift held, `key` would be "!" and the token would miss.
  expect(keyToken(press('Digit1'))).toBe('1');
  expect(keyToken(press('Digit1', true))).toBe('SHIFT-1');
  // The two keys `ACTIONBUTTON11`/`12` default to, which have no `Digit`/`Key` code of their own.
  expect(keyToken(press('Minus'))).toBe('-');
  expect(keyToken(press('Equal'))).toBe('=');

  const vm = new LuaVM();
  installBindingsApi(vm);
  setBindingTable(vm, commands, [['ACTIONBUTTON1', '1'], ['TOGGLESPELLBOOK', 'P']]);

  // command -> key, which is what `ActionButton_UpdateHotkeys` draws on the button.
  expect(vm.run('KEY = GetBindingKey("ACTIONBUTTON1")', 'test')).toBeNull();
  expect(vm.getGlobal('KEY')).toBe('1');
  expect(vm.run('TEXT = GetBindingText("1", "KEY_", 1)', 'test')).toBeNull();
  expect(vm.getGlobal('TEXT')).toBe('1');

  // key -> command -> the document's own Lua. Both halves of the press, since `runOnUp` is set.
  expect(dispatchBinding(vm, '1', true)).toBe(true);
  expect(vm.getGlobal('PRESSED')).toBe('down');
  expect(dispatchBinding(vm, '1', false)).toBe(true);
  expect(vm.getGlobal('PRESSED')).toBe('up');

  // An unbound key is NOT handled, which is what lets F5 and Ctrl+R still reach the browser.
  expect(dispatchBinding(vm, '9', true)).toBe(false);

  vm.dispose();
});
