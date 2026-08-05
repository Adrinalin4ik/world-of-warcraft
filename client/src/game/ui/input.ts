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

export class GlueInput {
  private readonly canvas: HTMLCanvasElement;
  private items: DrawItem[] = [];
  private pressed: Widget | null = null;
  private hovered: Widget | null = null;
  private focus: Widget | null = null;

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
    this.focus = widget;
    if (widget && widget.kind === 'editbox') {
      widget.caret = widget.text.length;
    }
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

    if (this.hovered !== hit) {
      if (this.hovered) {
        this.hovered.hovered = false;
      }
      if (hit) {
        hit.hovered = true;
      }
      this.hovered = hit;
    }

    if (this.pressed) {
      // Pressed art follows the pointer being over the widget, as the reference's buttons do.
      this.pressed.state = this.pressed === hit ? 'down' : 'up';
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

    pressed.state = 'up';

    const { x, y } = this.toUnits(event as PointerEvent);
    if (hitTest(this.items, x, y) !== pressed) {
      return; // Released off the widget: no click.
    }

    if (pressed.kind === 'checkbutton') {
      pressed.checked = !pressed.checked;
    }
    pressed.onClick?.();
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

    if (event.key === 'Enter' || event.key === 'Escape') {
      // The screen decides what submit/cancel mean; it reads these off the focused widget.
      target.onClick?.();
      return;
    }

    if (target.kind !== 'editbox') {
      return;
    }

    if (event.key === 'Backspace') {
      if (target.caret > 0) {
        target.text = target.text.slice(0, target.caret - 1) + target.text.slice(target.caret);
        target.caret -= 1;
      }
    } else if (event.key === 'Delete') {
      target.text = target.text.slice(0, target.caret) + target.text.slice(target.caret + 1);
    } else if (event.key === 'ArrowLeft') {
      target.caret = Math.max(0, target.caret - 1);
    } else if (event.key === 'ArrowRight') {
      target.caret = Math.min(target.text.length, target.caret + 1);
    } else if (event.key === 'Home') {
      target.caret = 0;
    } else if (event.key === 'End') {
      target.caret = target.text.length;
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

  /** Insert at the caret, honouring the box's `letters` cap. */
  private insert(target: Widget, text: string): void {
    const room = target.maxLetters > 0 ? target.maxLetters - target.text.length : text.length;
    const slice = text.slice(0, Math.max(0, room));
    if (!slice) {
      return;
    }
    target.text = target.text.slice(0, target.caret) + slice + target.text.slice(target.caret);
    target.caret += slice.length;
  }
}
