/**
 * Input routing: DOM events on the canvas to widget state.
 *
 * Pointer coordinates convert to logical units and go through `hitTest` on the same draw list the
 * renderer used, so what the player clicks is what the player sees. Press CAPTURE matters: a press
 * that drags off a button and releases elsewhere must not fire the click, and must still clear the
 * pressed art.
 *
 * Text entry is a real edit box -- printable keys, backspace/delete, arrows, home/end and paste. In
 * a browser paste is a `paste` event; the reference needed a whole host-clipboard module for this.
 */
import { focusChain, hitTest, nextFocus } from './hit';
import { viewportUnits } from './layout';
import { DrawItem, Widget } from './widget';

/**
 * How close two clicks have to be to count as a double click. OURS: the real client reads the host's
 * double-click interval, and a browser exposes no such setting -- `dblclick` has its own hidden one.
 */
const DOUBLE_CLICK_MS = 500;

export class GlueInput {
  private readonly canvas: HTMLCanvasElement;
  private items: DrawItem[] = [];
  private pressed: Widget | null = null;
  private hovered: Widget | null = null;
  private focus: Widget | null = null;
  /** The last completed click, for `onDoubleClick`. */
  private lastClick: { widget: Widget; time: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setDrawList(items: DrawItem[]): void {
    this.items = items;
  }

  get focused(): Widget | null {
    return this.focus;
  }

  setFocus(widget: Widget | null): void {
    if (this.focus === widget) {
      return;
    }
    // Refuse disabled widgets.
    if (widget && widget.state === 'disabled') {
      return;
    }
    this.focus = widget;
    if (widget && widget.kind === 'editbox') {
      widget.caret = widget.text.length;
      widget.selectionAnchor = widget.caret;
    }
  }

  /**
   * Forget every widget this router is tracking. A screen transition retires the whole draw list,
   * so a stale focus, armed press or hover target left pointing at the old screen's widgets could
   * fire that screen's handlers on the next Enter/Tab/pointer move.
   */
  reset(): void {
    if (this.hovered) {
      this.hovered.hovered = false;
    }
    this.hovered = null;
    this.pressed = null;
    this.focus = null;
    // A click on the retired screen must not pair with the first click on the new one.
    this.lastClick = null;
  }

  attach(): void {
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('paste', this.onPaste);
  }

  detach(): void {
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('paste', this.onPaste);
  }

  /** Canvas-relative pixels to logical units. */
  private toUnits(event: PointerEvent): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    const units = viewportUnits({ width: bounds.width, height: bounds.height });
    const scale = bounds.height / units.height;
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  }

  private onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.toUnits(event);
    const hit = hitTest(this.items, x, y);

    // Hover skips disabled widgets.
    const hoverTarget = hit && hit.state !== 'disabled' ? hit : null;
    if (this.hovered !== hoverTarget) {
      if (this.hovered) {
        this.hovered.hovered = false;
      }
      if (hoverTarget) {
        hoverTarget.hovered = true;
      }
      this.hovered = hoverTarget;
    }

    if (this.pressed) {
      // Pressed art follows the pointer being over the widget, but guards against disabled.
      if (this.pressed.state !== 'disabled') {
        this.pressed.state = this.pressed === hit ? 'down' : 'up';
      }
    }
  };

  private onPointerDown = (event: PointerEvent): void => {
    const { x, y } = this.toUnits(event);
    const hit = hitTest(this.items, x, y);

    this.setFocus(hit && hit.focusable ? hit : null);

    if (hit && hit.state !== 'disabled') {
      this.pressed = hit;
      hit.state = 'down';
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed) {
      return;
    }

    // If the widget became disabled during the press, clear the press but do not fire the click.
    if (pressed.state === 'disabled') {
      return;
    }

    pressed.state = 'up';

    const { x, y } = this.toUnits(event as PointerEvent);
    if (hitTest(this.items, x, y) !== pressed) {
      return; // Released off the widget: no click.
    }

    if (pressed.kind === 'checkbutton') {
      pressed.checked = !pressed.checked;
    }
    pressed.onClick?.();

    // FrameXML's `OnDoubleClick`: two clicks on the SAME widget inside the interval. It fires after
    // the second `onClick`, not instead of it, because that is the order the engine's own is
    // documented in -- the realm list's double-click joins the realm its first click selected.
    const now = performance.now();
    if (
      this.lastClick &&
      this.lastClick.widget === pressed &&
      now - this.lastClick.time <= DOUBLE_CLICK_MS
    ) {
      // Cleared, so a third click starts a new pair rather than firing again on every click.
      this.lastClick = null;
      pressed.onDoubleClick?.();
    } else {
      this.lastClick = { widget: pressed, time: now };
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      event.preventDefault();
      this.setFocus(nextFocus(focusChain(this.items), this.focus, event.shiftKey));
      return;
    }

    const target = this.focus;
    if (!target) {
      return;
    }

    if (event.key === 'Enter') {
      if (target.state !== 'disabled') {
        // `onSubmit` wins where a widget has one: an edit box's Enter (FrameXML `OnEnterPressed`) is
        // NOT its pointer click, which only takes focus. Everything without one -- every button, every
        // list row -- keeps activating on Enter through `onClick`, where keyboard and pointer
        // activation genuinely mean the same thing.
        const activate = target.onSubmit ?? target.onClick;
        activate?.();
      }
      event.preventDefault();
      return;
    }

    if (event.key === 'Escape') {
      if (target.state !== 'disabled') {
        target.onCancel?.();
      }
      this.setFocus(null);
      event.preventDefault();
      return;
    }

    if (target.kind !== 'editbox') {
      return;
    }

    if (event.key === 'Backspace') {
      if (this.hasSelection(target)) {
        this.deleteSelection(target);
      } else if (target.caret > 0) {
        target.text = target.text.slice(0, target.caret - 1) + target.text.slice(target.caret);
        target.caret -= 1;
        target.selectionAnchor = target.caret;
      }
    } else if (event.key === 'Delete') {
      if (this.hasSelection(target)) {
        this.deleteSelection(target);
      } else {
        target.text = target.text.slice(0, target.caret) + target.text.slice(target.caret + 1);
      }
    } else if (event.key === 'ArrowLeft') {
      if (event.shiftKey) {
        target.caret = Math.max(0, target.caret - 1);
      } else if (this.hasSelection(target)) {
        this.collapse(target, this.selectionStart(target));
      } else {
        this.collapse(target, Math.max(0, target.caret - 1));
      }
    } else if (event.key === 'ArrowRight') {
      if (event.shiftKey) {
        target.caret = Math.min(target.text.length, target.caret + 1);
      } else if (this.hasSelection(target)) {
        this.collapse(target, this.selectionEnd(target));
      } else {
        this.collapse(target, Math.min(target.text.length, target.caret + 1));
      }
    } else if (event.key === 'Home') {
      if (event.shiftKey) {
        target.caret = 0;
      } else {
        this.collapse(target, 0);
      }
    } else if (event.key === 'End') {
      if (event.shiftKey) {
        target.caret = target.text.length;
      } else {
        this.collapse(target, target.text.length);
      }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      this.insert(target, event.key);
    } else {
      return;
    }

    event.preventDefault();
  };

  private onPaste = (event: ClipboardEvent): void => {
    const target = this.focus;
    if (!target || target.kind !== 'editbox') {
      return;
    }
    const text = event.clipboardData?.getData('text') ?? '';
    if (text) {
      this.insert(target, text.replace(/\s+/g, ' '));
      event.preventDefault();
    }
  };

  private hasSelection(target: Widget): boolean {
    return target.selectionAnchor !== target.caret;
  }

  private selectionStart(target: Widget): number {
    return Math.min(target.selectionAnchor, target.caret);
  }

  private selectionEnd(target: Widget): number {
    return Math.max(target.selectionAnchor, target.caret);
  }

  /** Collapse to a single position -- caret and anchor together, as a plain Arrow/Home/End does. */
  private collapse(target: Widget, position: number): void {
    target.caret = position;
    target.selectionAnchor = position;
  }

  /** Remove the selected range, leaving the caret (and anchor, collapsed) at its start. */
  private deleteSelection(target: Widget): void {
    const start = this.selectionStart(target);
    const end = this.selectionEnd(target);
    target.text = target.text.slice(0, start) + target.text.slice(end);
    this.collapse(target, start);
  }

  /**
   * Insert at the caret, honouring the box's `letters` cap. A live selection is replaced rather
   * than inserted alongside -- typing or pasting over a selection is standard text-box behaviour.
   */
  private insert(target: Widget, text: string): void {
    const hasSelection = this.hasSelection(target);
    const start = hasSelection ? this.selectionStart(target) : target.caret;
    const end = hasSelection ? this.selectionEnd(target) : target.caret;

    const budget = hasSelection
      ? target.text.length - (end - start)
      : target.text.length;
    const room = target.maxLetters > 0 ? target.maxLetters - budget : text.length;
    const slice = text.slice(0, Math.max(0, room));
    if (!slice && hasSelection) {
      // Nothing fits, but a selection still needs to clear on type-over.
      this.deleteSelection(target);
      return;
    }
    if (!slice) {
      return;
    }

    target.text = target.text.slice(0, start) + slice + target.text.slice(end);
    this.collapse(target, start + slice.length);
  }
}
