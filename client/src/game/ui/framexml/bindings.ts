/**
 * THE BINDING TABLE -- `Interface\FrameXML\Bindings.xml`, and the key-to-command map the engine owns.
 *
 * Only mouse clicks reached an action button before this. The real client does NOT route a key press to
 * a button directly; it runs a key through a table of named COMMANDS, each of which is a piece of the
 * client's own Lua, and that Lua is what clicks the button. `Bindings.xml` is where those commands are
 * declared, and it is a document type this runtime had never loaded:
 *
 *     <Binding name="ACTIONBUTTON1" runOnUp="true" header="ACTIONBAR">
 *         if ( keystate == "down" ) then
 *             ActionButtonDown(1);
 *         else
 *             ActionButtonUp(1);
 *         end
 *     </Binding>
 *
 * and `ActionButtonUp` (`actionbutton.lua:29-43`) is:
 *
 *     if ( button:GetButtonState() == "PUSHED" ) then
 *         button:SetButtonState("NORMAL");
 *         SecureActionButton_OnClick(button, "LeftButton");
 *         ActionButton_UpdateState(button);
 *     end
 *
 * -- the SAME `SecureActionButton_OnClick` a pointer click reaches (`SecureTemplates.xml:13`). So a
 * bound key and a mouse click converge on one path inside the client's Lua, and the engine's whole job
 * is: parse this document, remember which key holds which command, and on a real key event run that
 * command's script with a `keystate` local. Nothing about an action button is known to TypeScript here.
 *
 * ## Where the file is, and the trap in fetching it
 *
 * `Bindings.xml` is NOT in `FrameXML.toc` -- it is loaded by the engine, not by the manifest, which is
 * why it is fetched separately below rather than appearing in the 264 files. Measured on the served
 * file: 36,792 bytes, `<Bindings>` root, **275 `<Binding>` elements**, 16 `<ModifiedClick>` elements
 * and 19 `header=` attributes (one per group).
 *
 * And the asset host is CASE-SENSITIVE and serves lowercase only:
 *
 *     Interface/FrameXML/Bindings.xml  -> 404
 *     interface/framexml/bindings.xml  -> 200, 36792 bytes
 *
 * `manifest.ts#cacheKey` already lowercases, and `net/loader` goes through the same path the manifest
 * does, so passing the mixed-case name is correct here -- but a hand-written `fetch` of the pretty name
 * would 404 silently, and that is worth recording.
 *
 * ## What is deliberately NOT here
 *
 * The DEFAULT key assignments. See `DEFAULT_BINDINGS`: those live in the client's binary, not in any
 * file this project can read, so they are the one unsourced value in this file and are marked as such.
 */
import {
  XmlElement, attr, attrBool, parseXmlRoot,
} from './xml';
import Loader from '../../net/loader';

/** One `<Binding>`: a command name and the Lua the engine runs when its key is pressed. */
export interface BindingCommand {
  /** `ACTIONBUTTON1`, `TOGGLESPELLBOOK`, ... -- what `GetBindingKey` is asked about. */
  name: string;
  /**
   * `runOnUp="true"`: the script runs on the key's RELEASE as well as its press, with `keystate` saying
   * which. 3.3.5a's `Bindings.xml` sets this on **101** of the 275 commands (counted on the served
   * file), and every `ACTIONBUTTON` is one of them -- which matters, because `ActionButtonDown` only
   * pushes the button in and
   * `ActionButtonUp` is what casts. A binding run on the press alone would light the button and never
   * fire the spell.
   */
  runOnUp: boolean;
  /** The element's text: a Lua chunk, compiled on first use. */
  script: string;
  /** `header="ACTIONBAR"` groups commands in the key-binding UI. Carried for `GetBindingHeader`. */
  header: string | null;
}

/**
 * Parse a `<Bindings>` document.
 *
 * Order is preserved, because `GetBinding(index)` and `GetNumBindings()` are index-based over exactly
 * this list (`KeyBindingFrame.lua` walks it), and a `header` element occupies an index of its own in the
 * real client's enumeration. Headers are attached to the command that declares them instead, which is
 * how the attribute is actually authored -- `header` sits ON the first `<Binding>` of each group
 * (measured: `ACTIONBUTTON1` carries `header="ACTIONBAR"` and `ACTIONBUTTON2..12` carry none).
 */
export function parseBindings(text: string): BindingCommand[] {
  const { root } = parseXmlRoot(text);
  if (root === null) {
    return [];
  }
  // Walked rather than read as direct children of `<Bindings>`, which costs nothing and cannot be wrong
  // for a nested element.
  //
  // **It did NOT explain the count, and that is recorded rather than glossed.** `GetNumBindings()` answers
  // **273** against a `grep -c '<Binding name='` of **275** on the served file, and it still answers 273
  // after this walk -- so the two missing commands are not nested, and where they go is UNEXPLAINED. Not
  // duplicates and not nameless either: both were checked (`sort | uniq -d` empty, every element carries
  // `name=`). The two are somewhere in the debug block around `uiparent.lua`-era lines 780-800, whose
  // indentation is inconsistent in the shipped file, so `DOMParser` recovering from something is the
  // standing suspicion. It costs two of 275 `hidden="true" debug="true"` commands that nothing binds a key
  // to, which is why it was not chased further -- but a silently short table is how a key that should be
  // bound is not, so the next reader should not assume the count is right.
  const out: BindingCommand[] = [];
  const walk = (element: XmlElement): void => {
    if (element.tag.toLowerCase() === 'binding') {
      const name = attr(element, 'name');
      if (name !== undefined && name !== '') {
        out.push({
          name,
          runOnUp: attrBool(element, 'runOnUp'),
          // `body` is the element's OWN direct text, which for a `<Binding>` is the whole Lua chunk --
          // a `<Binding>` has no element children, so "own text" and "all text" coincide here.
          script: element.body,
          header: attr(element, 'header') ?? null,
        });
      }
      return;
    }
    element.children.forEach(walk);
  };
  root.children.forEach(walk);
  return out;
}

/**
 * THE DEFAULT KEY ASSIGNMENTS, and this is the one table here with no file behind it.
 *
 * Stated plainly per `CLAUDE.md`: **these values are not read from any data this project has.** The
 * shipped defaults live in the 3.3.5a client's own binary and in a `WTF/Account/.../bindings-cache.wtf`
 * that a fresh account has never written; neither is on the asset host (`bindings-cache.wtf` and
 * `wtf/config.wtf` both 404). They are transcribed from the client's documented out-of-the-box layout
 * and are the values an unmodified 3.3.5a install shows in Key Bindings.
 *
 * Kept deliberately SMALL -- the action bar and the two panels the owner asked about, not all 275
 * commands. A command with no entry here simply has no key until `SetBinding` gives it one, which is
 * the honest state: `GetBindingKey` answers nil and `ActionButton_UpdateHotkeys` draws the range
 * indicator instead of a hotkey, exactly as it does for an unbound button in the real client.
 *
 * `ACTIONBUTTON1..12` -> `1 2 3 4 5 6 7 8 9 0 - =` is the layout the owner is asking to work.
 */
export const DEFAULT_BINDINGS: ReadonlyArray<readonly [string, string]> = [
  ['ACTIONBUTTON1', '1'],
  ['ACTIONBUTTON2', '2'],
  ['ACTIONBUTTON3', '3'],
  ['ACTIONBUTTON4', '4'],
  ['ACTIONBUTTON5', '5'],
  ['ACTIONBUTTON6', '6'],
  ['ACTIONBUTTON7', '7'],
  ['ACTIONBUTTON8', '8'],
  ['ACTIONBUTTON9', '9'],
  ['ACTIONBUTTON10', '0'],
  ['ACTIONBUTTON11', '-'],
  ['ACTIONBUTTON12', '='],
  ['TOGGLESPELLBOOK', 'P'],
  ['TOGGLECHARACTER0', 'C'],
  ['TOGGLEBACKPACK', 'B'],
  // THE MAP KEYS, added because the owner asked for them by name: "hotkey на карту не настроены.
  // Режим shift + m тоже не включается." All three COMMANDS are the client's own
  // (`bindings.xml:659-674`) -- `ToggleFrame(WorldMapFrame)`, `WorldMapFrame_ToggleWindowSize()` behind
  // an `IsShown` guard, and `ToggleFrame(QuestLogFrame)` -- so the engine side is only the key.
  //
  // `SHIFT-M` is `TOGGLEWORLDMAPSIZE`, not a second way to open the map: it switches the open map
  // between its windowed and full-screen layouts, which is the "режим" he means. Its binding body does
  // nothing at all when the map is shut, by the client's own guard.
  //
  // The KEYS carry this table's standing note: transcribed from the shipped layout, not read from any
  // data this project has.
  ['TOGGLEWORLDMAP', 'M'],
  ['TOGGLEWORLDMAPSIZE', 'SHIFT-M'],
  ['TOGGLEQUESTLOG', 'L'],
  ['TOGGLEGAMEMENU', 'ESCAPE'],
  // TAB and SHIFT-TAB. `Bindings.xml:456-461` is the pair -- `TargetNearestEnemy()` and
  // `TargetNearestEnemy(1)`, whose own comment reads "1 (or "true") means reverse!". The KEYS carry the
  // same standing as everything else in this table: transcribed from the shipped layout, not read from
  // any data this project has.
  ['TARGETNEARESTENEMY', 'TAB'],
  ['TARGETPREVIOUSENEMY', 'SHIFT-TAB'],
  // NAMEPLATES -> V, the owner's own request ("на букву v должен включаться индикатор здоровья").
  // The COMMAND is not ours: `Bindings.xml:544-553` is a real `<Binding name="NAMEPLATES">` whose body
  // reads `GetCVarBool("nameplateShowEnemies")` and writes the two nameplate CVars back, and the engine
  // reads those CVars. So the whole toggle is the client's own Lua and the engine side is a CVar read
  // (`game/world/nameplates.ts`). The KEY carries this table's standing note.
  ['NAMEPLATES', 'V'],
  // The other two rungs of the same three-way, so shift and ctrl do what the real client does rather
  // than nothing. `Bindings.xml:554-563` and `:564-573`; FRIENDNAMEPLATES shows friendly plates only and
  // ALLNAMEPLATES shows both.
  /**
   * ENTER AND SLASH -- and their absence was the whole of "я не могу писать".
   *
   * The chat edit box is `hidden="true"` in its own document and NOTHING in the client shows it on a
   * pointer click: `ChatEdit_ActivateChat` is what does the `editBox:Show()` and `SetFocus()`
   * (`chatframe.lua:3382-3409`), and its route in from a keyboard is one binding --
   *
   *     <Binding name="OPENCHAT" header="CHAT">ChatFrame_OpenChat("");</Binding>
   *     <Binding name="OPENCHATSLASH">ChatFrame_OpenChat("/");</Binding>
   *
   * (`bindings.xml:93-98`). With no key holding `OPENCHAT`, the box could not be reached at all: the
   * frame loaded, the messages arrived and rendered, and the owner had no way to open the field. He
   * saw exactly that -- other people's lines visible, no input.
   *
   * `ChatFrame_OpenChat` needs nothing this runtime lacks; checked against its body
   * (`chatframe.lua:3045-3057`) and `ChatEdit_ActivateChat`'s: `Show`, `SetFocus`, `SetFrameStrata`,
   * `Raise`, `SetAlpha`, `GetAttribute`/`SetAttribute` are all real methods here.
   *
   * A press with the box already focused does NOT re-open it -- `input.ts#onKeyDown` consults the
   * binding table only while `this.focus === null`, which is the reference's own rule
   * (`target/scan.rs:501` refuses a bound key while an EditBox owns the keyboard). So Enter opens the
   * field and the next Enter reaches the field's `OnEnterPressed`, which is what sends the message.
   *
   * The KEYS carry this table's standing note: transcribed from the shipped layout, not read from any
   * data this project has.
   */
  ['OPENCHAT', 'ENTER'],
  ['OPENCHATSLASH', '/'],
  ['FRIENDNAMEPLATES', 'SHIFT-V'],
  ['ALLNAMEPLATES', 'CTRL-V'],
];

/**
 * A browser `KeyboardEvent` -> the client's own key token, or null for a key the client has no name for.
 *
 * The token is what `Bindings.xml`'s table is keyed by and what `GetBindingKey` returns, so the mapping
 * has to produce the client's spelling and not the browser's: `event.key` for a digit is already `"1"`,
 * but for the arrows it is `"ArrowUp"` where the client says `"UP"`, and for the modifiers it wants a
 * `SHIFT-`/`CTRL-`/`ALT-` PREFIX rather than a separate token.
 *
 * `event.code` is used for the printable keys rather than `event.key`, deliberately: `event.key` for
 * `Digit1` is `"1"` unshifted but `"!"` with shift held, so a `SHIFT-1` binding keyed off `event.key`
 * would look for a command bound to `"!"` and find nothing. `code` is layout-position and stable under
 * modifiers, which is the same property the client's own scan codes have.
 *
 * The modifier ORDER is the client's: `ALT-CTRL-SHIFT-` (`SecureTemplates.lua` builds the same prefix
 * for its modified attributes in that order), so `SHIFT-CTRL-1` is spelled `CTRL-SHIFT-1`.
 */
export function keyToken(event: KeyboardEvent): string | null {
  const base = baseToken(event);
  if (base === null) {
    return null;
  }
  let token = base;
  if (event.shiftKey && !MODIFIER_KEYS.has(base)) {
    token = `SHIFT-${token}`;
  }
  if (event.ctrlKey && !MODIFIER_KEYS.has(base)) {
    token = `CTRL-${token}`;
  }
  if (event.altKey && !MODIFIER_KEYS.has(base)) {
    token = `ALT-${token}`;
  }
  return token;
}

/** The modifier tokens themselves take no prefix -- `SHIFT-SHIFT` is not a key. */
const MODIFIER_KEYS = new Set(['LSHIFT', 'RSHIFT', 'LCTRL', 'RCTRL', 'LALT', 'RALT']);

/**
 * `event.code` -> the client's unmodified key token.
 *
 * Only the codes the client has a name for. Anything else answers null and the key event is left alone,
 * which is what lets an unhandled key fall through to the browser instead of being swallowed.
 */
function baseToken(event: KeyboardEvent): string | null {
  const code = event.code;

  // Digits. `Digit1`..`Digit0` -> `1`..`0`; the client names them by the character, not the position.
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) {
    return digit[1];
  }
  // Letters. `KeyA` -> `A`, upper case, which is the client's spelling.
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) {
    return letter[1];
  }
  // Function keys and the numeric keypad, whose names the client shares with the browser's `code`.
  const fkey = /^F([0-9]{1,2})$/.exec(code);
  if (fkey !== null) {
    return code;
  }
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad !== null) {
    return `NUMPAD${numpad[1]}`;
  }
  return NAMED_CODES[code] ?? null;
}

/**
 * The named keys, `event.code` -> client token.
 *
 * The tokens are the ones `Bindings.xml` and `GlobalStrings.lua`'s `KEY_*` entries use. `Minus` and
 * `Equal` matter most here: they are `ACTIONBUTTON11` and `ACTIONBUTTON12`'s default keys.
 */
const NAMED_CODES: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'SPACE',
  Escape: 'ESCAPE',
  Enter: 'ENTER',
  NumpadEnter: 'ENTER',
  Tab: 'TAB',
  Backspace: 'BACKSPACE',
  Delete: 'DELETE',
  Insert: 'INSERT',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PAGEUP',
  PageDown: 'PAGEDOWN',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  NumpadAdd: 'NUMPADPLUS',
  NumpadSubtract: 'NUMPADMINUS',
  NumpadMultiply: 'NUMPADMULTIPLY',
  NumpadDivide: 'NUMPADDIVIDE',
  NumpadDecimal: 'NUMPADDECIMAL',
  ShiftLeft: 'LSHIFT',
  ShiftRight: 'RSHIFT',
  ControlLeft: 'LCTRL',
  ControlRight: 'RCTRL',
  AltLeft: 'LALT',
  AltRight: 'RALT',
};

/** `Interface\FrameXML\Bindings.xml`, fetched through the same `Loader` the manifest uses. */
export async function fetchBindings(): Promise<BindingCommand[]> {
  try {
    const bytes = await new Loader().load('Interface\\FrameXML\\Bindings.xml');
    return parseBindings(new TextDecoder('utf-8').decode(bytes));
  } catch (error) {
    // A report line rather than a throw, for the reason `bootWorldRuntime` gives: a data problem is
    // something the client survives. With no table, no key is bound and only the mouse works -- which
    // is exactly the state before this file existed, so the failure is a regression to it and not a
    // new break.
    console.warn('Bindings.xml: could not be fetched; no key will be bound', error);
    return [];
  }
}
