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
 *
 * THIS ROUTER IS SHARED by the hand-written screens and by the FrameXML runtime, and the difference
 * decides the shape of every callback below. A hand-written screen re-reads `hovered`, `state`, `text`
 * and `focused` off the widget every render tick, so a flag is enough for it. A `<Scripts>` block has
 * no field to be read out of -- only a handler to be called -- so every state change the router makes
 * also fires the matching `Widget#onX` hook (`widget.ts`), which `framexml/lua/scripts.ts` binds to
 * the frame's Lua handler. Those hooks are null on every transcribed screen, which is why adding them
 * changed nothing about how `/` behaves.
 */
import { keyToken } from './framexml/bindings';
import { focusChain, hitTest, wheelTargetAt, nextFocus, paneAt, sliderThumbAt } from './hit';
import { layoutRectOf } from './rects';
import { viewportUnits } from './layout';
import { DrawItem, MouseButtonName, Widget } from './widget';
import type { ModelRig } from './scene/scene-rig';

/**
 * The default click registration: a Button that never called `RegisterForClicks` takes the LEFT button
 * only, which is the engine's own default. See `Widget#clickButtons`.
 */
const LEFT_ONLY: ReadonlySet<MouseButtonName> = new Set<MouseButtonName>(['LeftButton']);

/**
 * A DOM `PointerEvent#button` as FrameXML names it.
 *
 * The DOM order is 0 left, 1 MIDDLE, 2 RIGHT -- middle and right are not adjacent to left in the order
 * a reader expects, and getting that backwards would send every right-click to the middle button. 3 and
 * 4 are the back/forward buttons, which FrameXML calls `Button4`/`Button5`. Anything else is reported as
 * the left button, since the alternative is a click that silently does nothing.
 */
function buttonName(event: PointerEvent): MouseButtonName {
  switch (event.button) {
    case 2: return 'RightButton';
    case 1: return 'MiddleButton';
    case 3: return 'Button4';
    case 4: return 'Button5';
    default: return 'LeftButton';
  }
}

/**
 * How close two clicks have to be to count as a double click. OURS: the real client reads the host's
 * double-click interval, and a browser exposes no such setting -- `dblclick` has its own hidden one.
 */
const DOUBLE_CLICK_MS = 500;

/**
 * How far the mouse turns a model pane, in RADIANS PER LOGICAL UNIT of horizontal travel.
 *
 * DERIVED from the client's own drag rate and not chosen: `CHARACTER_ROTATION_CONSTANT = 0.6`
 * (characterselect.lua:4) is what `CharacterSelectFrame_OnUpdate` multiplies the cursor's horizontal
 * travel by, and the value it feeds is `SetCharacterSelectFacing`, which is in DEGREES
 * (`api/characters.ts:142-148`: "as radians the same drag would be 57 revolutions"). A model frame's
 * `SetRotation` is in radians, so the same rate is `0.6 * PI / 180`.
 *
 * WHAT IS OURS about it: the client's own paper-doll drag is engine behaviour with no script and no
 * constant we can read (see `hit.ts#paneAt`), so the CHOICE to reuse the glue screen's rate for it is
 * this project's, not the client's. The unit is also not identical -- the glue Lua reads
 * `GetCursorPosition()` in CSS pixels while this reads logical units -- so on a window taller than 768
 * the same physical drag turns the figure slightly less than the glue screen would. Named rather than
 * hidden; if the owner reports the drag as too slow or too fast, this is the number.
 */
const MODEL_DRAG_RADIANS_PER_UNIT = (0.6 * Math.PI) / 180;

/**
 * How far the pointer must travel, in LOGICAL UNITS, before a press becomes a drag.
 *
 * OURS: the real client's threshold is not published and a browser exposes none. 4 units at the 768-unit
 * reference height is about 5 device pixels on a 911-tall window -- far enough that the jitter in a
 * deliberate click does not start a drag, close enough that a drag feels immediate. It is deliberately
 * NOT zero: a zero threshold turns every click whose pointer moves one pixel into a drag, and since a
 * drag SUPPRESSES the click that would make casting from the action bar intermittent.
 */
const DRAG_THRESHOLD_UNITS = 4;

export class GlueInput {
  private readonly canvas: HTMLCanvasElement;
  private items: DrawItem[] = [];
  private pressed: Widget | null = null;

  /**
   * Which button the live press used, so the release can report it.
   *
   * Held on the press rather than read off the release event because a `pointerup` for a chorded release
   * reports the button that CHANGED, and the press is the one the click belongs to. Defaults to
   * `LeftButton` so a synthetic release with no press before it behaves as it always did.
   */
  private pressButton: MouseButtonName = 'LeftButton';
  private hovered: Widget | null = null;
  private focus: Widget | null = null;
  /** The last completed click, for `onDoubleClick`. */
  private lastClick: { widget: Widget; time: number } | null = null;

  /**
   * Where the live press began, in logical units, or null when nothing is pressed.
   *
   * Kept separately from `pressed` rather than as a field on it, for the reason `region.ts`'s `userPlaced`
   * WeakSet gives: a widget outlives one gesture and a screen teardown must not leave a stale origin on it.
   */
  private pressOrigin: { x: number; y: number } | null = null;

  /** The widget a drag is currently in progress FROM, or null. Set once the threshold is crossed. */
  private dragging: Widget | null = null;

  /**
   * A model pane being spun by the mouse: its rig, where the press started and what the yaw was then.
   *
   * ABSOLUTE from the press rather than accumulated per move, which is not how the client's own glue
   * drag is written (`CharacterSelectFrame_OnUpdate` re-bases its start on every tick,
   * characterselect.lua:490-496) and is deliberate: that shape only works because it runs in an
   * `OnUpdate` at a fixed cadence, while this runs on `pointermove`, whose events coalesce. Summing
   * per-event deltas would make the same physical drag turn the figure by a different amount depending
   * on how many moves the browser chose to deliver.
   */
  private rotating: { rig: ModelRig; startX: number; startRotation: number } | null = null;

  /** See the click-drop diagnostics: one line for the whole session. */
  private announcedClickDropFlag = false;

  /**
   * THE SLIDER BEING DRAGGED, which nothing in this client could do before -- the owner reported the
   * scrollbar's drag dead in every round.
   *
   * `grab` is where inside the thumb the press landed, so the knob does not jump under the cursor on the
   * first move; `travel` is the track length MINUS the thumb, which is the distance a fraction of 1 has
   * to cover. Captured at press time: re-reading the rects mid-drag would follow a thumb that this very
   * drag is moving, and the fraction would chase itself.
   */
  private sliding: {
    slider: Widget;
    grab: number;
    trackStart: number;
    travel: number;
    vertical: boolean;
  } | null = null;

  /**
   * The mouse-enabled widget the LIVE press landed on, or null when it landed on the world.
   *
   * Kept apart from `pressed`, which is the widget being HELD: `pressed` is only set for a widget that
   * was enabled at press time, and a DISABLED frame still swallows the mouse in the real client -- the
   * frame is mouse-enabled, so the world behind it never sees the button at all. Basing the world's gate
   * on `pressed` would let a press on a greyed-out spell button orbit the camera.
   */
  private pressHit: Widget | null = null;

  /**
   * The pointer's last position in LOGICAL UNITS, for the host's cursor-attachment pass.
   *
   * Exposed from here rather than from a second `pointermove` listener because there must be exactly one
   * coordinate convention: `api/screen.ts`'s `GetCursorPosition` tracker deliberately reports CSS pixels
   * with Y measured UP from the bottom (the engine's convention, which the client's own Lua divides by
   * `GetEffectiveScale()`), while the draw list, `hitTest` and `toUnits` all work in logical units with Y
   * DOWN from the top. An icon drawn from the wrong one of those two lands mirrored vertically.
   */
  private pointerUnits: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setDrawList(items: DrawItem[]): void {
    this.items = items;
  }

  get focused(): Widget | null {
    return this.focus;
  }

  /**
   * The widget the pointer is currently over, or null when it is over the world.
   *
   * THE WORLD CLICK PATH'S GATE. `pages/game/controls` raycasts units on a left-click, and a click
   * that landed on an action button must not also select whatever unit happens to be behind it. This
   * router already knows -- it recomputes the hit on every `pointermove` for hover art -- so asking
   * it is both free and guaranteed to agree with what the UI itself thought it was doing. A second,
   * independent hit test in the world path would be a second answer that could differ.
   *
   * It is the LAST MOVE's hit, not this instant's: a pointer that has not moved since the UI changed
   * under it reports the stale widget. That is the same staleness the hover ART has, which is what a
   * player sees, so the two cannot visibly disagree.
   */
  get pointerWidget(): Widget | null {
    return this.hovered;
  }

  /**
   * THE WORLD DRAG PATH'S GATE: the widget that CONSUMED the live press, or null.
   *
   * `pointerWidget` already stopped a click on a button from also selecting a unit, but a click is only
   * half of what a press starts. `pages/game/controls` latches `buttons.left`/`buttons.right` on its own
   * `mousedown` (on `document.body`, so every press on the canvas bubbles to it) and from there
   * `runLookSession` orbits the camera and asks for a pointer lock -- all of it from the SAME press this
   * router is using to drag an ability. The owner's report is exactly that: "камера тоже двигается и не
   * получается в итоге передвинуть способность". Once the lock is granted `clientX/clientY` FREEZE, so
   * the drag's own `pointermove`s stop advancing and the release resolves back onto the source button.
   *
   * So a press that lands on a mouse-enabled widget is CONSUMED here and must never be seen by the
   * camera. This getter is how the world asks. Same rule and same reason as `input.ts`'s focus
   * precedence: one press has ONE owner, and the UI is in front.
   *
   * It reports the press HIT rather than `pressed` -- see `pressHit` for why a disabled frame still
   * counts -- and it is live for the whole gesture, cleared on the release and by `reset`.
   */
  get capturedPress(): Widget | null {
    return this.pressHit;
  }

  /**
   * The pointer's last position in LOGICAL UNITS, or null before the first move. See `pointerUnits`.
   *
   * Read by `world-ui.ts#drawCursorIcon` to put the dragged ability's icon under the cursor.
   */
  get pointerPosition(): { x: number; y: number } | null {
    return this.pointerUnits;
  }

  setFocus(widget: Widget | null): void {
    if (this.focus === widget) {
      return;
    }
    // Refuse disabled widgets.
    if (widget && widget.state === 'disabled') {
      return;
    }
    const previous = this.focus;
    this.focus = widget;
    if (widget && widget.kind === 'editbox') {
      widget.caret = widget.text.length;
      widget.selectionAnchor = widget.caret;
    }
    // FrameXML's `OnEditFocusLost` then `OnEditFocusGained`, in the engine's order and AFTER the
    // pointer has already moved: a handler is free to move focus again (the client's boxes call
    // `HighlightText` from both, and `AccountLogin_OnShow` moves focus from Lua), and firing before
    // the field settled would let a re-entrant call be overwritten by this one on the way out. The
    // re-check is what stops `gained` firing for a widget the `lost` handler has since moved off.
    previous?.onEditFocusLost?.();
    if (this.focus === widget) {
      widget?.onEditFocusGained?.();
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
    // ... and the world's gate must not stay shut on a widget from the retired screen.
    this.pressHit = null;
    this.focus = null;
    // A click on the retired screen must not pair with the first click on the new one.
    this.lastClick = null;
    // ... and a drag in progress across the transition must not drop onto the new screen, nor leave an
    // origin that would make the next press look like it had already moved.
    this.pressOrigin = null;
    this.dragging = null;
    this.rotating = null;
    this.sliding = null;
    // The last pointer position goes too: it is what the cursor-attachment pass draws at, and a stale one
    // would put a dragged icon wherever the pointer was on the retired screen until the next move.
    this.pointerUnits = null;
  }

  /**
   * THE BINDING SINK: a key that no focused widget wanted goes here.
   *
   * Set by the world UI host to `dispatchBinding` against its VM (`world-ui.ts`), and left null on the
   * glue screens, which have no binding table and no world to act on. Returns true when the key WAS
   * bound, which is what decides whether the browser's own handling of it is suppressed -- an unbound
   * key must still reach the page, or F5 and Ctrl+R stop working.
   *
   * A function slot rather than an import, for the same reason `FocusSink` is one: this router is shared
   * with the glue screens and must not know that a Lua VM exists.
   */
  keyBinding: ((token: string, down: boolean) => boolean) | null = null;

  /**
   * A DRAG RELEASED OVER NOTHING -- no mouse-enabled widget under the cursor, i.e. the world.
   *
   * The world is where an ability is thrown away, and `WorldFrame` has no `OnReceiveDrag` to run
   * (`worldframe.xml:23-77`), so unlike every other drop this one has no Lua handler to reach and needs
   * a door of its own. Set by the world UI host to `api/cursor.ts#dropCursorOnWorld`; null on the glue
   * screens, which have no cursor payload and no world.
   */
  dropOnWorld: (() => void) | null = null;

  /**
   * ESCAPE with nothing focused: the way out of a cursor that is carrying something.
   *
   * Consulted BEFORE the binding table, because Escape is bound to `TOGGLEGAMEMENU` and the real client
   * puts the cursor down rather than opening the menu when it has something in hand. Returns true when
   * it consumed the key. Set by the world UI host to `api/cursor.ts#cancelCursor`.
   */
  cancelCursor: (() => boolean) | null = null;

  attach(): void {
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    // NOT passive: a frame that handles the wheel must be able to stop the page scrolling with it.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('paste', this.onPaste);
  }

  detach(): void {
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('paste', this.onPaste);
  }

  /**
   * A key RELEASE, which exists only for the binding table.
   *
   * No edit box cares about a release, so this handler does nothing else -- and the release is where an
   * action button actually casts: `ActionButtonDown` pushes the button in and `ActionButtonUp` is the one
   * that reaches `SecureActionButton_OnClick` (`actionbutton.lua:29-43`). A keydown-only router would
   * light every button and fire nothing.
   */
  private onKeyUp = (event: KeyboardEvent): void => {
    if (this.keyBinding === null || this.focus !== null) {
      return;
    }
    const token = keyToken(event);
    if (token !== null && this.keyBinding(token, false)) {
      event.preventDefault();
    }
  };

  /** Canvas-relative pixels to logical units. */
  private toUnits(event: PointerEvent): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    const units = viewportUnits({ width: bounds.width, height: bounds.height });
    const scale = bounds.height / units.height;
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  }

  /**
   * FrameXML's `OnMouseWheel`, which reached NOTHING before -- this listener did not exist, so no frame
   * in the client could be scrolled by the wheel.
   *
   * The handler is looked up on the frame under the pointer and then **up its ancestors**, because that
   * is where the client puts it: `UIPanelScrollFrameTemplate` binds `<OnMouseWheel>` on the SCROLL FRAME
   * (`uipaneltemplates.xml:327-329`) while the pointer is over the scroll child's content. Stopping at
   * the hit widget would find nothing on almost every real wheel event.
   *
   * `preventDefault` only when a handler actually took it, so a wheel over the world still reaches
   * whatever else wants it.
   *
   * SIGN: the engine's `delta` is +1 up / -1 down -- `ScrollFrameTemplate_OnMouseWheel`'s
   * `if ( value > 0 )` branch SUBTRACTS from the scroll value (`uipaneltemplates.lua:158-165`), i.e.
   * wheel-up scrolls toward the top. A DOM `deltaY` is positive scrolling down, so it is negated.
   */
  private onWheel = (event: WheelEvent): void => {
    const { x, y } = this.toUnits(event as unknown as PointerEvent);
    this.pointerUnits = { x, y };
    // `wheelTargetAt`, NOT `hitTest` and a climb: over the quest text `hitTest` answers `QuestFrame`,
    // whose ancestors do not include the scroll frame that binds the handler. See `hit.ts`.
    const target = wheelTargetAt(this.items, x, y);
    if (target !== null) {
      event.preventDefault();
      /**
       * STOP THE BUBBLE, or the camera zooms while the panel scrolls -- the owner saw both happen at
       * once. `preventDefault` only suppresses the browser's default action; it does not stop the event
       * reaching another listener. `pages/game/controls/controls.tsx:156` registers its own `wheel`
       * handler on `document.body` (`:106`), which is an ANCESTOR of this canvas, so the event arrives
       * here in the target phase and at the camera afterwards by bubbling. Stopping propagation is
       * therefore enough, and it puts the wheel under the same rule as a press: the UI is in front, and
       * one gesture has one owner (`GlueInput#capturedPress`).
       */
      event.stopPropagation();
      target.onMouseWheel?.(event.deltaY > 0 ? -1 : 1);
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.toUnits(event);
    this.pointerUnits = { x, y };
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
      const left = this.hovered;
      this.hovered = hoverTarget;
      // FrameXML's `OnLeave`/`OnEnter`: the TRANSITION, which is the only thing this branch runs on.
      // The flag above is what a hand-written screen re-reads every tick; these are for a `<Scripts>`
      // block, which has no field to be read out of.
      left?.onLeave?.();
      hoverTarget?.onEnter?.();
    }

    // THE MODEL PANE'S SPIN, before the press bookkeeping and independent of it: a pane is not a
    // pressed widget (see `hit.ts#paneAt`), so nothing below would run for it.
    // THE THUMB FOLLOWS THE POINTER, and the value follows the thumb -- through Lua, so the client's
    // own `<OnValueChanged>` runs and the scroll frame is told. See `Widget#onSliderDrag`.
    if (this.sliding !== null) {
      const { slider, grab, trackStart, travel, vertical } = this.sliding;
      if (travel > 0) {
        const along = (vertical ? y : x) - grab - trackStart;
        slider.onSliderDrag?.(Math.max(0, Math.min(1, along / travel)));
      }
      return;
    }

    if (this.rotating !== null) {
      const rig = this.rotating.rig;
      const wanted = this.rotating.startRotation
        + (x - this.rotating.startX) * MODEL_DRAG_RADIANS_PER_UNIT;
      // Only on a real change: a `pointermove` with no horizontal travel (a vertical drag) would
      // otherwise bump the revision and cost a bake plus a full interface re-render for nothing.
      if (wanted !== rig.rotation) {
        rig.rotation = wanted;
        rig.revision += 1;
      }
    }

    if (this.pressed) {
      // Pressed art follows the pointer being over the widget, but guards against disabled -- and NOT
      // once a drag is in progress. Self-review caught that: `maybeBeginDrag` pops the button back out when
      // the drag starts, and this line would push it in again on any later move that passed back over the
      // source, so dragging an ability in a circle re-depressed its own button mid-flight.
      if (this.pressed.state !== 'disabled' && this.dragging === null) {
        this.pressed.state = this.pressed === hit ? 'down' : 'up';
      }
      this.maybeBeginDrag(x, y);
    }
  };

  /**
   * A press that has travelled past `DRAG_THRESHOLD_UNITS` becomes a drag: FrameXML's `OnDragStart`.
   *
   * Gated on `dragRegistered`, which is `RegisterForDrag`'s doing -- an unregistered frame can never start
   * a drag and therefore keeps its click, which is the engine's rule. Fires ONCE per press: `dragging` is
   * the latch, so continuing to move does not re-fire `OnDragStart`.
   *
   * The pressed art is released here. A frame being dragged is not a frame being held down, and the real
   * client pops the button back out the moment the drag begins -- leaving it depressed for the length of
   * the drag reads as a stuck button.
   */
  private maybeBeginDrag(x: number, y: number): void {
    const pressed = this.pressed;
    const origin = this.pressOrigin;
    if (pressed === null || origin === null || this.dragging !== null || !pressed.dragRegistered) {
      return;
    }
    const dx = x - origin.x;
    const dy = y - origin.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_UNITS * DRAG_THRESHOLD_UNITS) {
      return;
    }
    this.dragging = pressed;
    if (pressed.state !== 'disabled') {
      pressed.state = 'up';
    }
    pressed.onDragStart?.();
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pressButton = buttonName(event);
    const { x, y } = this.toUnits(event);
    const hit = hitTest(this.items, x, y);

    // BEFORE the enabled test below and outside it: this is what `capturedPress` answers, and the world
    // must be shut out by a press on a disabled frame too. `pointerdown` completes its whole propagation
    // before the compatibility `mousedown` is dispatched (UI Events / Pointer Events: the mouse event
    // follows the pointer event for the same press), so `controls`' body-level `mousedown` handler always
    // reads a value this line has already written.
    this.pressHit = hit;

    this.setFocus(hit && hit.focusable ? hit : null);

    // A PRESS ON A MODEL PANE. `paneAt` owns the z-order decision -- it answers null when anything
    // scriptable is on top, which is what keeps the two rotate buttons inside the pane's own rect
    // working as buttons. NOT gated on `hit === null` here: `CharacterFrame` is mouse-enabled and sits
    // under the pane, so `hitTest` always answers the panel and this branch never ran.
    const pane = paneAt(this.items, x, y);
    const paneRig = pane?.modelRig ?? null;
    if (paneRig !== null) {
      this.rotating = { rig: paneRig, startX: x, startRotation: paneRig.rotation };
      this.capturePointer(event);
    }

    // A PRESS ON A SCROLLBAR THUMB, and the same z-order reasoning as the pane above: the thumb is art
    // inside a mouse-enabled panel, so `hitTest` answers the panel and this cannot be gated on it.
    const thumb = sliderThumbAt(this.items, x, y);
    const slider = thumb?.widget.thumbOf ?? null;
    // `state` is checked because `Slider:Disable()` is real (`methods/scroll.ts`) and the client uses it
    // on a scrollbar with nothing to scroll (`HybridScrollFrame.lua:99`). Without this, `IsEnabled`
    // would report the bar dead while the pointer still dragged it.
    if (thumb !== null && slider !== null && slider.onSliderDrag !== null
      && slider.state !== 'disabled') {
      const track = layoutRectOf(slider.id);
      const vertical = slider.sliderTravel.vertical;
      if (track !== null) {
        const travel = vertical ? track.height - thumb.rect.height : track.width - thumb.rect.width;
        this.sliding = {
          slider,
          grab: vertical ? y - thumb.rect.top : x - thumb.rect.left,
          trackStart: vertical ? track.top : track.left,
          // A track no longer than its thumb has nowhere to travel; guarded so the fraction below is
          // never a division by zero, which would be NaN and would clamp to the top for ever.
          travel: travel > 0 ? travel : 0,
          vertical,
        };
        this.capturePointer(event);
      }
    }

    if (hit !== null && hit.state === 'disabled' && !this.announcedClickDropFlag) {
      this.announcedClickDropFlag = true;
      // eslint-disable-next-line no-console
      console.log(`click DROPPED: ${hit.id} is DISABLED at press (kind=${hit.kind})`);
    }
    if (hit && hit.state !== 'disabled') {
      this.pressed = hit;
      // The drag origin, for `maybeBeginDrag`. Recorded for every press, not only a registered one: the
      // registration can change between press and move (`SetScript`/`RegisterForDrag` are callable from a
      // handler), and an origin costs one object.
      this.pressOrigin = { x, y };
      /**
       * POINTER CAPTURE, and it is what makes a drag work at all rather than a nicety.
       *
       * `pointermove` is bound to the CANVAS (see `attach`), so any element that ends up over the canvas
       * mid-gesture takes the moves and the router simply stops being told where the pointer is -- it keeps
       * the last position it saw and drops the drag there. MEASURED: during a drag from `ActionButton1`
       * towards `ActionButton4`, `window` received ten `pointermove` events and the canvas received **one**,
       * so the release resolved to the source button and `OnReceiveDrag` fired on the wrong frame.
       *
       * `setPointerCapture` is the platform's own answer: every subsequent event for this pointer id is
       * retargeted to the canvas until the pointer is released, whatever is painted on top. It also fixes
       * the case the router could never handle -- a drag that leaves the canvas and comes back -- and it
       * covers the dev server's intermittent full-page overlay iframe, which has eaten clicks here before.
       *
       * Guarded because the API is absent in jsdom, where the unit tests run.
       */
      this.capturePointer(event);
      hit.state = 'down';
      // FrameXML's `OnMouseDown`, which is NOT the click: it fires on the press itself, and a press
      // that drags off and releases elsewhere still had one.
      hit.onMouseDown?.(this.pressButton);
    }
  };

  /**
   * Retarget every later event for this pointer to the canvas until it is released.
   *
   * Extracted so the model-pane spin gets it too, and it is not a nicety: `pointermove` is bound to the
   * CANVAS, so any element that ends up over it mid-gesture takes the moves and the router simply stops
   * being told where the pointer is. MEASURED on the ability drag it was written for: during a drag from
   * `ActionButton1` towards `ActionButton4`, `window` received ten `pointermove` events and the canvas
   * received **one**, so the release resolved back to the source button. It also covers a drag that
   * leaves the canvas and comes back, and the dev server's intermittent full-page overlay iframe, which
   * has eaten clicks here before.
   *
   * Guarded because the API is absent in jsdom, where the unit tests run.
   */
  private capturePointer(event: PointerEvent): void {
    if (typeof this.canvas.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is already gone throws `NotFoundError`. Nothing to capture, nothing to do.
      }
    }
  }

  private onPointerUp = (event: PointerEvent): void => {
    this.rotating = null;
    this.sliding = null;
    const pressed = this.pressed;
    const dragging = this.dragging;
    this.pressed = null;
    this.pressOrigin = null;
    this.dragging = null;
    // The press is over, so the world may have the next one. Cleared here rather than at the end because
    // every path below returns and one of them would leave the world shut out for good.
    this.pressHit = null;
    // Release the capture taken on the press, whatever happens below -- a capture left held would send
    // every later move to the canvas even with no button down, and hover would freeze for the next press.
    if (
      typeof this.canvas.releasePointerCapture === 'function'
      && event.pointerId !== undefined
      && this.canvas.hasPointerCapture?.(event.pointerId)
    ) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (!pressed) {
      return;
    }

    // If the widget became disabled during the press, clear the press but do not fire the click.
    if (pressed.state === 'disabled') {
      return;
    }

    pressed.state = 'up';
    // The counterpart of `OnMouseDown`: the engine fires `OnMouseUp` on the frame that took the press
    // wherever the release lands, so this is BEFORE the released-off-the-widget test below.
    pressed.onMouseUp?.(this.pressButton);

    const { x, y } = this.toUnits(event as PointerEvent);
    this.pointerUnits = { x, y };
    const released = hitTest(this.items, x, y);

    /**
     * THE DROP, and it must be handled BEFORE the released-off-the-widget return below -- that return is
     * exactly the case a drag needs, because a drop's whole purpose is to land somewhere else.
     *
     * `OnDragStop` goes to the SOURCE and `OnReceiveDrag` to whatever is under the cursor, which the
     * engine fires in that order. A drop on nothing (the world, or a frame with no handler) still stops
     * the drag -- `ClearCursor` is not called for it, so the ability stays on the cursor, which is the
     * real client's behaviour for a drop on an invalid target.
     *
     * The target gets `OnReceiveDrag` even when it IS the source: dropping an ability back on the slot it
     * came from is a real gesture, and the client's own Lua ends it by calling `PlaceAction(self.action)`
     * with the same slot, which `api/cursor.ts#place` treats as a no-op that clears the cursor. Without
     * this the cursor would keep the ability after a cancelled move.
     *
     * A drag SUPPRESSES the click, which is why this returns rather than falling through: releasing a
     * drag over the button it started on must not also cast the ability, and `lastClick` must not be
     * updated or the next real click would pair with a drag and fire `OnDoubleClick`.
     */
    if (dragging !== null) {
      dragging.onDragStop?.();
      // A DISABLED frame is not a drop target, the same rule the click path below applies to a press. An
      // empty `SpellButton` is disabled by `SpellButton_UpdateButton` (`spellbookframe.lua:432`), so
      // without this a drop on a blank half of the book would run its `OnReceiveDrag`.
      if (released !== null && released.state !== 'disabled') {
        released.onReceiveDrag?.();
      } else if (released === null) {
        // RELEASED OVER THE WORLD, which is the discard gesture -- see `dropOnWorld`. A release over a
        // DISABLED widget is deliberately not this case: the frame swallowed the mouse (the same rule
        // `pressHit` follows), so the ability was not thrown at the world and stays in hand.
        this.dropOnWorld?.();
      }
      return;
    }

    /**
     * EVERY SILENT DROP IN THIS PATH IS NAMED ONCE, and the reason is a measurement that came back
     * entirely clean.
     *
     * The owner's gossip quest row reported `shown=true h=15 w=300 type=Active id=1 onclick=true` and
     * -- from the client's own `GetMouseFocus()` -- itself as the widget under the cursor. Then clicking
     * it produced no handler call at all. That is this project's recorded signature: a registered
     * handler is not a dispatched one. There are exactly three places below where a press is discarded
     * with no trace, and guessing between them has already cost two rounds.
     *
     * One line each, once per session, so this can never become per-click noise.
     */
    if (released !== pressed) {
      if (!this.announcedClickDropFlag) {
        this.announcedClickDropFlag = true;
        // eslint-disable-next-line no-console
        console.log(`click DROPPED: released off the widget -- pressed=${pressed.id} `
          + `released=${released === null ? 'null' : released.id}`);
      }
      return; // Released off the widget: no click.
    }

    /**
     * THE BUTTON IS NOW REAL, AND ITS ABSENCE WAS WHY NOTHING COULD BE EQUIPPED.
     *
     * Every click used to reach Lua as `"LeftButton"` regardless of the button pressed, so a RIGHT-click
     * on a bag slot ran `ContainerFrameItemButton_OnClick`'s LEFT branch -- `PickupContainerItem`, which
     * is the declared item-cursor gap -- rather than its right branch, `UseContainerItem`, which sends
     * `CMSG_AUTOEQUIP_ITEM` and was correct all along. See `Widget#clickButtons`.
     *
     * The registration gate is the engine's: a frame that never called `RegisterForClicks` takes LEFT
     * only. Applied HERE rather than in `scripts.ts` because it is a routing decision -- the handler is
     * bound once and the button varies per press.
     *
     * **THE RETURN COVERS THE CHECKBOX TOGGLE AND THE DOUBLE-CLICK BOOKKEEPING TOO, and self-review
     * caught that it did not.** With the gate wrapped around `onClick` alone, a right-click on a
     * left-only CheckButton still flipped `checked` -- a checkbox that toggles visibly and tells its
     * handler nothing, which is worse than either doing nothing or doing everything. And `lastClick`
     * was still recorded, so a suppressed right-click could pair with a later left click into a
     * spurious `OnDoubleClick`. An unregistered button is not a click at all.
     */
    const button = this.pressButton;
    if (!(pressed.clickButtons ?? LEFT_ONLY).has(button)) {
      if (!this.announcedClickDropFlag) {
        this.announcedClickDropFlag = true;
        // eslint-disable-next-line no-console
        console.log(`click DROPPED: ${button} not registered on ${pressed.id} -- `
          // NULLISH, not `undefined`: `Widget#clickButtons` defaults to `null`, which is exactly what
          // the `??` gate above treats as "unregistered". My first version tested `=== undefined` and
          // spread a null -- caught by `click-button.test.ts`, which is what that test is for.
          + `clickButtons=${pressed.clickButtons == null ? 'default(LEFT)'
            : `[${[...pressed.clickButtons].join(',')}]`}`);
      }
      return;
    }
    if (!this.announcedClickDropFlag && pressed.onClick === null) {
      this.announcedClickDropFlag = true;
      // eslint-disable-next-line no-console
      console.log(`click DROPPED: ${pressed.id} has no onClick bound (kind=${pressed.kind})`);
    }

    if (pressed.kind === 'checkbutton') {
      pressed.checked = !pressed.checked;
    }
    pressed.onClick?.(button);

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
      pressed.onDoubleClick?.(this.pressButton);
    } else {
      this.lastClick = { widget: pressed, time: now };
    }
  };

  /**
   * `pointercancel`: the press is over and NO `pointerup` is coming.
   *
   * The platform fires it when it takes the pointer away -- a browser gesture claiming it, the device
   * going away, a capture the page loses. Without this the press stays latched: `pressed` keeps a widget
   * depressed, `pressHit` keeps the world shut out of the camera for good, and `dragging` being non-null
   * makes `maybeBeginDrag` refuse every later drag AND makes the next release be read as this drag's
   * drop. `OnDragStop` fires because the drag really did stop; nothing receives it, so a cancelled drag
   * leaves the ability on the cursor exactly as a release over the world's UI-less parts would.
   */
  private onPointerCancel = (): void => {
    const dragging = this.dragging;
    if (this.pressed && this.pressed.state !== 'disabled') {
      this.pressed.state = 'up';
    }
    this.pressed = null;
    this.pressOrigin = null;
    this.pressHit = null;
    this.dragging = null;
    dragging?.onDragStop?.();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      event.preventDefault();
      // A widget that declares `OnTabPressed` decides where Tab goes -- `accountlogin.xml`'s account
      // box focuses the password box, and its password box picks between the token box and back to the
      // account box, neither of which a generic draw-order ring can express. Nothing hand-written sets
      // this, so the ring below is still what every transcribed screen does.
      const focused = this.focus;
      if (focused && focused.state !== 'disabled' && focused.onTabPressed) {
        focused.onTabPressed();
        return;
      }
      // TAB IS A BINDING WHEN NOTHING IS FOCUSED, and this early return was the whole of "Tab does not
      // select the nearest enemy": the focus ring below claimed every press before the binding table
      // was consulted, so `TARGETNEARESTENEMY` could never fire however well it was bound. The gate is
      // the reference's own -- `target/scan.rs:501` refuses the press only while `UiKeyboardCapture` is
      // set, i.e. while an EditBox owns the keyboard.
      //
      // The FALL-THROUGH is what keeps the glue screens working: `dispatch` answers false for a key no
      // command holds, and the glue runtime installs no binding table at all, so Tab there still walks
      // the focus chain exactly as before.
      if (focused === null && this.keyBinding !== null && !event.repeat) {
        const token = keyToken(event);
        if (token !== null && this.keyBinding(token, true)) {
          return;
        }
      }
      this.setFocus(nextFocus(focusChain(this.items), this.focus, event.shiftKey));
      return;
    }

    const target = this.focus;
    if (!target) {
      // ESCAPE FIRST, and only while the cursor is carrying something: `cancelCursor` answers false with
      // an empty cursor, so Escape still reaches `TOGGLEGAMEMENU` in the ordinary case. This is the one
      // exit from a cursor that has picked an ability up -- see `api/cursor.ts#cancelCursor`.
      if (event.key === 'Escape' && !event.repeat && this.cancelCursor?.()) {
        event.preventDefault();
        return;
      }
      // NOTHING FOCUSED, so the key belongs to the binding table -- the client's own rule, and the
      // reason it is tested here rather than first: a key typed into an edit box must reach the box and
      // not cast a spell, which is what `keystate`-bound `ACTIONBUTTON1` on the `1` key would otherwise
      // do to anyone typing in the chat frame.
      //
      // `event.repeat` is dropped: the browser auto-repeats a held key at ~30 Hz and the real client
      // fires a binding once per physical press. Repeating would send one `CMSG_CAST_SPELL` per repeat.
      if (this.keyBinding !== null && !event.repeat) {
        const token = keyToken(event);
        if (token !== null && this.keyBinding(token, true)) {
          event.preventDefault();
        }
      }
      return;
    }

    if (event.key === 'Enter') {
      if (target.state !== 'disabled') {
        // `onSubmit` wins where a widget has one: an edit box's Enter (FrameXML `OnEnterPressed`) is
        // NOT its pointer click, which only takes focus. Everything without one -- every button, every
        // list row -- keeps activating on Enter through `onClick`, where keyboard and pointer
        // activation genuinely mean the same thing.
        const activate = target.onSubmit ?? target.onClick;
        // `'LeftButton'` explicitly: Enter on a button is a LEFT click in the engine, and `onSubmit`
        // ignores the argument. Passing the last POINTER button here would make a keyboard activation
        // inherit whichever button was last pressed somewhere else on screen.
        activate?.('LeftButton');
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

    /**
     * THE CLIPBOARD AND SELECT-ALL CHORDS, which were the whole of what a keyboard could not do here.
     *
     * Measured on :3000 before this block (`scratchpad/t13-edit.js`, `?ui=lua`, the real
     * `AccountLoginAccountEdit`): typing "abcd" gave text "a","ab","abc","abcd", Backspace gave "abc",
     * and Shift+ArrowLeft gave caret 2 / anchor 3 -- so per-character editing and the selection MODEL
     * were already correct. `Ctrl+A` left caret and anchor untouched and `Ctrl+C`/`Ctrl+V` moved no
     * text. Those three, plus a selection nothing drew (`framexml/tick.ts#placeSelection`), are the
     * defect; "any edit clears the field" is the select-all-on-focus described there, not a lost edit.
     *
     * Handled BEFORE the printable-character branch below, which already excluded `ctrlKey`, so these
     * keys previously fell through its `else { return; }` without `preventDefault` -- which is why
     * `Ctrl+V` still worked: the browser went on to fire its own `paste` event, and `onPaste` takes it.
     * `Ctrl+V` is therefore deliberately NOT handled here; intercepting it would mean reading the
     * clipboard asynchronously, and `navigator.clipboard.readText()` needs a permission a `paste` event
     * does not.
     *
     * `metaKey` alongside `ctrlKey` because the same chords are Cmd-based on a Mac and `config.os` is
     * `OSX`, so a Mac user reaches this code.
     */
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const chord = event.key.toLowerCase();
      if (chord === 'a') {
        // The client's own `HighlightText()` with no arguments: anchor at 0, caret at the end
        // (`lua/methods/kinds.ts#HighlightText`). Written directly rather than by calling into the Lua
        // method, because this router must not know a VM exists -- the same rule `keyBinding` follows.
        target.selectionAnchor = 0;
        target.caret = target.text.length;
        event.preventDefault();
        return;
      }
      if (chord === 'c' || chord === 'x') {
        // A PASSWORD BOX IS NEVER COPIED. `displayText` masks the value on screen for exactly this
        // reason, and putting the real password on the system clipboard would defeat that from a
        // keystroke the player cannot see the effect of. The real client does not copy out of a
        // password box either.
        if (!this.hasSelection(target) || target.password) {
          event.preventDefault();
          return;
        }
        const selected = target.text.slice(this.selectionStart(target), this.selectionEnd(target));
        // Fire-and-forget: the write is async and there is nothing to do with a rejection but ignore
        // it (a browser that refuses clipboard-write leaves the selection exactly as it was).
        void navigator.clipboard?.writeText(selected).catch(() => undefined);
        if (chord === 'x') {
          const before = target.text;
          this.deleteSelection(target);
          if (target.text !== before) {
            target.onTextChanged?.();
          }
        }
        event.preventDefault();
        return;
      }
      // Every other chord -- Ctrl+V included, and Ctrl+R, Ctrl+Shift+I -- is left to the browser.
      return;
    }

    // Read before the edit, compared after it: FrameXML's `OnTextChanged` fires when the text really
    // changed, and every branch below has a case that leaves it alone (Backspace at position 0, an
    // arrow key, an insert with no room left). One comparison at the end covers all of them and cannot
    // drift the way a call per branch would.
    const before = target.text;

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

    if (target.text !== before) {
      target.onTextChanged?.();
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
      const before = target.text;
      this.insert(target, text.replace(/\s+/g, ' '));
      if (target.text !== before) {
        target.onTextChanged?.();
      }
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
