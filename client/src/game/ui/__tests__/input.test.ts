import { GlueInput } from '../input';
import { Widget, WidgetRoot } from '../widget';

const viewport = { width: 1024, height: 768 };

function tree() {
  const root = new WidgetRoot();

  const button = root.root.add(new Widget('button', 'button'));
  button.layer = 'ARTWORK';
  button.mouseEnabled = true;
  button.focusable = true;
  button.setSize(100, 40).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

  return root;
}

/** An editbox widget, focused and ready for key-level tests -- no DOM, no draw list needed. */
function focusedEditBox(input: GlueInput, text: string): Widget {
  const root = new WidgetRoot();
  const box = root.root.add(new Widget('editbox', 'box'));
  box.mouseEnabled = true;
  box.focusable = true;
  box.text = text;
  box.setSize(200, 32).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

  input.setFocus(box); // caret + anchor land at text.length, exactly as a real focus does
  return box;
}

/** Drive the router's key handling directly, bypassing DOM KeyboardEvent construction entirely. */
/**
 * A `KeyboardEvent`-shaped object.
 *
 * **`code` AS WELL AS `key`, and its absence made this fixture assert a defect.** A real event always
 * carries both; this one carried only `key`, so the Ctrl chords -- which read `code` because
 * `event.key` on a Cyrillic layout gives "ф" for the A key -- saw `undefined` and did nothing. The
 * test passed for as long as the code under it read the layout-dependent field.
 *
 * Derived rather than passed: a single-letter key is `Key<X>` and everything else is its own name,
 * which is what a browser reports for every key this suite presses.
 */
function pressKey(
  input: GlueInput,
  key: string,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): void {
  const event = {
    key,
    code: /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
    shiftKey: !!modifiers.shiftKey,
    ctrlKey: !!modifiers.ctrlKey,
    metaKey: !!modifiers.metaKey,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent;

  (input as unknown as { onKeyDown: (event: KeyboardEvent) => void }).onKeyDown(event);
}

/** Drive the router's paste handling directly, bypassing a real ClipboardEvent/DataTransfer. */
function pressPaste(input: GlueInput, text: string): void {
  const event = {
    clipboardData: { getData: () => text },
    preventDefault: () => undefined,
  } as unknown as ClipboardEvent;

  (input as unknown as { onPaste: (event: ClipboardEvent) => void }).onPaste(event);
}

describe('GlueInput.reset', () => {
  it('clears the focused widget and the hover flag it set', () => {
    const canvas = document.createElement('canvas');
    const input = new GlueInput(canvas);
    const items = tree().drawList(viewport);
    input.setDrawList(items);

    const button = items[0].widget;
    input.setFocus(button);
    // Poke the private hover tracking directly -- reaching this state through a real
    // pointermove would need a full DOM event + layout round-trip that adds nothing here.
    (input as unknown as { hovered: Widget | null }).hovered = button;
    button.hovered = true;

    expect(input.focused).toBe(button);

    input.reset();

    expect(input.focused).toBeNull();
    expect(button.hovered).toBe(false);
    expect((input as unknown as { hovered: Widget | null }).hovered).toBeNull();
  });

  it('is safe to call with nothing focused or hovered', () => {
    const canvas = document.createElement('canvas');
    const input = new GlueInput(canvas);

    expect(() => input.reset()).not.toThrow();
    expect(input.focused).toBeNull();
  });
});

describe('GlueInput EditBox selection', () => {
  function newInput(): GlueInput {
    return new GlueInput(document.createElement('canvas'));
  }

  it('focuses with the caret and anchor collapsed at the end of the text', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    expect(box.caret).toBe(5);
    expect(box.selectionAnchor).toBe(5);
  });

  it('Shift+ArrowLeft/Right extends the selection without moving the anchor', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Home');
    expect(box.caret).toBe(0);
    expect(box.selectionAnchor).toBe(0);

    pressKey(input, 'ArrowRight', { shiftKey: true });
    pressKey(input, 'ArrowRight', { shiftKey: true });
    pressKey(input, 'ArrowRight', { shiftKey: true });

    expect(box.selectionAnchor).toBe(0);
    expect(box.caret).toBe(3);
  });

  it('Shift+Home/End extends to the edge of the string', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'ArrowLeft'); // collapse to end - 1 = 4
    pressKey(input, 'Home', { shiftKey: true });
    expect(box.caret).toBe(0);
    expect(box.selectionAnchor).toBe(4);

    pressKey(input, 'End', { shiftKey: true });
    expect(box.caret).toBe(5);
    expect(box.selectionAnchor).toBe(4);
  });

  it('a plain Arrow/Home/End collapses an existing selection instead of moving further', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Home');
    pressKey(input, 'ArrowRight', { shiftKey: true });
    pressKey(input, 'ArrowRight', { shiftKey: true }); // selects "he", anchor 0, caret 2

    pressKey(input, 'ArrowRight'); // plain: collapse to the selection's right edge, not caret + 1
    expect(box.caret).toBe(2);
    expect(box.selectionAnchor).toBe(2);

    pressKey(input, 'ArrowLeft', { shiftKey: true }); // re-select "e" (anchor 2, caret 1)
    expect(box.selectionAnchor).toBe(2);
    expect(box.caret).toBe(1);

    pressKey(input, 'ArrowLeft'); // plain: collapse to the selection's left edge
    expect(box.caret).toBe(1);
    expect(box.selectionAnchor).toBe(1);
  });

  it('typing over a selection replaces it, not inserts alongside it', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Home');
    pressKey(input, 'ArrowRight', { shiftKey: true });
    pressKey(input, 'ArrowRight', { shiftKey: true }); // selects "he"

    pressKey(input, 'X');

    expect(box.text).toBe('Xllo');
    expect(box.caret).toBe(1);
    expect(box.selectionAnchor).toBe(1);
  });

  it('pasting over a selection replaces it', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Home');
    pressKey(input, 'ArrowRight', { shiftKey: true });
    pressKey(input, 'ArrowRight', { shiftKey: true }); // selects "he"

    pressPaste(input, 'AB');

    expect(box.text).toBe('ABllo');
    expect(box.caret).toBe(2);
    expect(box.selectionAnchor).toBe(2);
  });

  it('Backspace removes a selection instead of one character before the caret', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Home');
    pressKey(input, 'ArrowRight', { shiftKey: true });
    pressKey(input, 'ArrowRight', { shiftKey: true }); // selects "he"

    pressKey(input, 'Backspace');

    expect(box.text).toBe('llo');
    expect(box.caret).toBe(0);
    expect(box.selectionAnchor).toBe(0);
  });

  it('Delete removes a selection instead of the character at the caret', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Home');
    pressKey(input, 'ArrowRight', { shiftKey: true });
    pressKey(input, 'ArrowRight', { shiftKey: true }); // selects "he"

    pressKey(input, 'Delete');

    expect(box.text).toBe('llo');
    expect(box.caret).toBe(0);
    expect(box.selectionAnchor).toBe(0);
  });

  it('Backspace/Delete with no selection behave as before (single character)', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Backspace'); // no selection: caret/anchor both at 5
    expect(box.text).toBe('hell');
    expect(box.caret).toBe(4);
    expect(box.selectionAnchor).toBe(4);

    pressKey(input, 'Home');
    pressKey(input, 'Delete');
    expect(box.text).toBe('ell');
    expect(box.caret).toBe(0);
    expect(box.selectionAnchor).toBe(0);
  });

  it('respects the letters cap when replacing a selection', () => {
    const input = newInput();
    const box = focusedEditBox(input, 'hello');
    box.maxLetters = 5;

    pressKey(input, 'Home');
    pressKey(input, 'ArrowRight', { shiftKey: true }); // selects "h"

    pressPaste(input, 'ABCDEFG'); // only room for 1 more character after removing "h"

    expect(box.text.length).toBeLessThanOrEqual(5);
    expect(box.text).toBe('Aello');
  });
});

/**
 * Ctrl+A, the chord the owner reported as dead. It IS the client's own `HighlightText()` with no
 * arguments -- anchor 0, caret at the end -- which is what every login box's `<OnEditFocusGained>`
 * calls (accountlogin.xml:218-220), so this also covers the range the selection highlight draws.
 *
 * Measured dead before the fix on :3000 against the real `AccountLoginAccountEdit`: Ctrl+A left
 * caret 2 / anchor 3 untouched (`scratchpad/t13-edit.js`).
 */
describe('GlueInput edit-box chords', () => {
  it('Ctrl+A selects the whole value', () => {
    const input = new GlueInput(document.createElement('canvas'));
    const box = focusedEditBox(input, 'hello');

    pressKey(input, 'Home'); // collapse to 0,0 so the select-all is a real change
    expect(box.selectionAnchor).toBe(box.caret);

    pressKey(input, 'a', { ctrlKey: true });

    expect(box.selectionAnchor).toBe(0);
    expect(box.caret).toBe(5);
    // And Ctrl+A must not be mistaken for typing the letter "a" over the selection.
    expect(box.text).toBe('hello');
  });
});
