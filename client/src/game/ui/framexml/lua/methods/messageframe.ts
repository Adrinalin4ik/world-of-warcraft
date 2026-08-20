/**
 * `MessageFrame` -- the class behind `UIErrorsFrame`, i.e. the red line the game prints when it refuses
 * to do something.
 *
 * ## Why this class exists at all, and why it is this small
 *
 * The owner: "there're not alerts when I'm trying to do something restrictive, like wearing a mail while
 * mage etc." Two things were missing and this file is the second of them -- the first is the packet
 * (`network/game/object/items.ts#handleEquipError`), the second is that **there was nowhere to print
 * it**: `UIErrorsFrame` is declared as `<MessageFrame name="UIErrorsFrame" displayDuration="5"
 * insertMode="TOP" ...>` (`uierrorsframe.xml:4`) and `MessageFrame` was not a `WidgetClass`, so the
 * frame did not exist, so `UIErrorsFrame_OnLoad` never registered for `UI_ERROR_MESSAGE` and
 * `UIErrorsFrame:AddMessage(...)` was a call on nil.
 *
 * **The surface is ONE METHOD, and that is measured rather than chosen.** Across all 268 files of the
 * loaded manifest there is exactly one `<MessageFrame>` element (`uierrorsframe.xml:4`) and exactly one
 * method ever called on it: `AddMessage` (the other three calls -- `RegisterEvent`, `UnregisterEvent`,
 * `GetFrameLevel` -- are FRAME/REGION methods it inherits). So `SetTimeVisible`, `SetInsertMode`,
 * `SetFading`, `Clear` and the rest of the real class's surface are **absent, not stubbed**, which is the
 * same rule `methods/gametooltip.ts` records for its own `Set<Thing>Item` tail: a method nothing calls
 * is a method whose contract nothing has pinned.
 *
 * ## The lines are real FontStrings under the frame, cloned from the one the document authors
 *
 * `uierrorsframe.xml:19` declares a single `<FontString inherits="ErrorFont" justifyH="CENTER"/>` with
 * no name. That is the engine's PROTOTYPE: the real client stamps one visible string per live message
 * from it. So the first line here IS that authored region (it is already in the tree as the frame's only
 * child), and any further line is created through the registry with the prototype's own resolved font
 * copied onto it -- never a loose `Widget`, so `registry.reset()` tears them down with everything else.
 * This is the same "create the engine's own regions through the registry" rule `framexml/tick.ts`
 * follows for the edit-box caret.
 *
 * ## Cost, and why there is no fade
 *
 * `world-ui.ts#drawListSignature` mixes **`item.alpha`** (`:126`), so a message fading over a second
 * would dirty the draw fingerprint on every frame of that second and hand back the 4-7.5 ms the
 * offscreen target saves on ~92% of frames. The real client does fade; **this does not**, and the
 * difference is stated rather than hidden: a message holds at full opacity for `displayDuration` and
 * then hides. That is **two** fingerprint changes per message -- one when it appears, one when it goes --
 * and exactly zero cost on every frame in between, which is the pattern the cooldown sweeps, the
 * selection ring and the nameplates all measured at zero.
 *
 * The engine's own fade curve is unsourced here anyway: `displayDuration="5"` is the only timing the
 * document states, and nothing in the manifest calls `SetFadeDuration`.
 *
 * When nothing is on screen `tickMessageFrames` returns on a `Map.size` test and the line regions are
 * `shown = false`, so they are not in the draw list at all.
 */
import { MethodTable, MethodContext, onFrameTeardown, registerMethods } from '../object';
import { Widget } from '../../../widget';

/** One line on screen. `until` is in the same seconds-since-boot clock `tickMessageFrames` advances. */
interface MessageLine {
  region: Widget;
  expiresAt: number;
}

interface MessageFrameState {
  frameId: number;
  lines: MessageLine[];
  /** Regions built for this frame, live or free. Index 0 is the authored prototype when there is one. */
  regions: Widget[];
  /** `displayDuration`, in seconds. The document's own value; see `setMessageFrameDuration`. */
  holdSeconds: number;
  /** `insertMode="TOP"`: the newest message is drawn topmost. */
  insertTop: boolean;
}

/**
 * How many messages can be on screen at once.
 *
 * OURS, and stated as such: `uierrorsframe.xml` gives the frame a height of 60 logical units and the
 * `ErrorFont` it inherits is 16, so three lines is what the authored box actually holds. The real
 * client's own cap is not stated in any served file.
 */
const MAX_LINES = 3;

/** Seconds since the host started ticking. Advanced by `tickMessageFrames`. */
let clock = 0;

const stateByFrame = new Map<number, MessageFrameState>();

onFrameTeardown((_ctx, id) => {
  stateByFrame.delete(id);
});

/**
 * `displayDuration="<n>"` from the document. Called by the loader's attribute pass, which is where every
 * other LoadXML attribute is honoured -- see `loader.ts#applyAttrs`.
 *
 * A frame with no state yet gets one, because the attribute is applied at load and the first
 * `AddMessage` may be seconds later.
 */
export function setMessageFrameDuration(frameId: number, seconds: number): void {
  stateOf(frameId).holdSeconds = seconds;
}

/** `insertMode="TOP"` / `"BOTTOM"` from the document. */
export function setMessageFrameInsertMode(frameId: number, mode: string): void {
  stateOf(frameId).insertTop = mode.toUpperCase() === 'TOP';
}

function stateOf(frameId: number): MessageFrameState {
  let state = stateByFrame.get(frameId);
  if (state === undefined) {
    state = { frameId, lines: [], regions: [], holdSeconds: 5, insertTop: true };
    stateByFrame.set(frameId, state);
  }
  return state;
}

/** `r`,`g`,`b` as 0..1 floats to the `#rrggbb` string `FontSpec.color` holds. */
function toHex(r: number, g: number, b: number): string {
  const channel = (value: number): string => Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The line regions for this frame, built up to `MAX_LINES`.
 *
 * The FIRST one is the document's own authored `<FontString>` if it has one -- reusing it rather than
 * hiding it and building a parallel set is what keeps the font, the justification and the draw layer the
 * ones the document asked for. The rest are created through the registry and given that same resolved
 * font, so all three lines match without this file naming a font anywhere.
 */
function regionsOf(ctx: MethodContext, state: MessageFrameState): Widget[] {
  if (state.regions.length > 0) {
    return state.regions;
  }
  const frame = ctx.registry.widget(state.frameId);
  if (frame === undefined) {
    return state.regions;
  }
  const authored = frame.children.find((child) => child.kind === 'fontstring') ?? null;
  if (authored !== null) {
    state.regions.push(authored);
  }
  while (state.regions.length < MAX_LINES) {
    const id = ctx.registry.create('FontString', null, state.frameId);
    const region = ctx.registry.widget(id);
    if (region === undefined) {
      break;
    }
    if (authored !== null && authored.font !== null) {
      // The PROTOTYPE'S OWN font, copied whole rather than rebuilt from a `FontResolution`: the authored
      // region's `FontSpec` has already been through the loader's `inherits="ErrorFont"` chain, shadow
      // and all, so a spread cannot drift from it the way a re-derived subset could. A fresh object per
      // line because `AddMessage` writes `color` into it.
      region.font = { ...authored.font };
    }
    state.regions.push(region);
  }
  for (const region of state.regions) {
    region.shown = false;
  }
  return state.regions;
}

/**
 * Lay the live messages out, newest first when `insertMode="TOP"`.
 *
 * Each line is anchored to the FRAME rather than to the line above it: a chain of sibling anchors would
 * have to be re-pointed every time a message expires out of the middle of the stack, and the client's
 * own layout pass resolves absolute offsets just as cheaply.
 */
function reflow(state: MessageFrameState, regions: Widget[]): void {
  const frame = regions[0]?.parent ?? null;
  const lineHeight = regions[0]?.font?.size ?? 16;
  const order = state.insertTop ? state.lines : [...state.lines].reverse();
  for (const region of regions) {
    region.shown = false;
  }
  order.forEach((line, index) => {
    line.region.shown = true;
    line.region.setAnchors({
      point: 'TOP',
      relativeTo: frame?.id,
      relativePoint: 'TOP',
      x: 0,
      // `+y` is UP in a FrameXML anchor offset (`ui/layout.ts:33`), so stacking DOWNWARD is negative.
      y: -index * lineHeight,
    });
    line.region.width = frame?.width ?? 512;
    line.region.height = lineHeight;
  });
}

/**
 * Expire what has been up long enough. Called once per host tick from `world-runtime.ts#update`.
 *
 * Free when idle: the `size` test below is the whole cost with no message on screen, which is almost
 * always. See the header for why there is no per-frame fade.
 */
export function tickMessageFrames(dt: number): void {
  clock += dt;
  if (stateByFrame.size === 0) {
    return;
  }
  // `now` rather than the module-level `clock` inside the loop: eslint's `no-loop-func` is right that a
  // closure over a mutable outer binding in a loop is a hazard, and one read per tick is also cheaper.
  const now = clock;
  for (const state of stateByFrame.values()) {
    if (state.lines.length === 0) {
      continue;
    }
    const live = state.lines.filter((line) => line.expiresAt > now);
    if (live.length !== state.lines.length) {
      state.lines = live;
      reflow(state, state.regions);
    }
  }
}

const MESSAGEFRAME: MethodTable = {
  /**
   * `AddMessage(text, r, g, b, holdTime)` -- print one line.
   *
   * `UIErrorsFrame_OnEvent` is the only caller in the manifest and passes all five for all three of its
   * events (`uierrorsframe.lua:9-17`): `SYSMSG` forwards the server's own colour, `UI_INFO_MESSAGE` is
   * yellow `1,1,0` and `UI_ERROR_MESSAGE` is red `1,0.1,0.1`. So the colour is ALWAYS the caller's and
   * never chosen here -- which matters, because the red is what makes a refusal read as a refusal.
   *
   * `holdTime` is the fifth argument and is `1.0` on all three call sites. That is NOT a duration in
   * seconds -- five seconds is what `displayDuration="5"` says, and a one-second error line would be
   * gone before it was read. The real client's fifth parameter is documented as the message's ALPHA, and
   * `1.0` on every call site is consistent with that and inconsistent with a hold time. It is accepted
   * and ignored here, and the hold comes from the document's `displayDuration`; said plainly because the
   * argument's name in the community API listing is misleading.
   */
  AddMessage: (ctx, self, args) => {
    const text = args[0];
    if (typeof text !== 'string' || text === '') {
      return [];
    }
    const state = stateOf(self);
    const regions = regionsOf(ctx, state);
    if (regions.length === 0) {
      return [];
    }
    // The oldest line is the one recycled when all three are busy -- the real client scrolls the stack
    // rather than dropping the new message, and the new message is the one the player needs to see.
    if (state.lines.length >= regions.length) {
      state.lines.shift();
    }
    const used = new Set(state.lines.map((line) => line.region));
    const region = regions.find((candidate) => !used.has(candidate));
    if (region === undefined) {
      return [];
    }
    region.text = text;
    if (region.font !== null && typeof args[1] === 'number') {
      region.font.color = toHex(Number(args[1]), Number(args[2]), Number(args[3]));
    }
    state.lines.push({ region, expiresAt: clock + state.holdSeconds });
    reflow(state, regions);
    return [];
  },
};

registerMethods('MESSAGEFRAME', MESSAGEFRAME);
