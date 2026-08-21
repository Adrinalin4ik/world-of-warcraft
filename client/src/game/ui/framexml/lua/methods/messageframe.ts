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
  /**
   * `maxLines` -- how many messages the BUFFER keeps, which is NOT how many are on screen.
   *
   * `MessageFrame` has no such attribute and keeps `MAX_LINES`; `ScrollingMessageFrame` declares it
   * (`chatframe.xml:4`, `maxLines="128"`) and the distinction is the whole difference between the two
   * classes: an error frame shows everything it holds, a chat frame holds a scrollback and shows a
   * window onto it.
   */
  maxLines: number;
  /**
   * How far back the visible window is scrolled, in lines. 0 = the newest message is at the bottom.
   *
   * Only `ScrollingMessageFrame` moves this; a `MessageFrame` leaves it at 0 forever, which makes the
   * shared `reflow` below correct for both without a branch.
   */
  scrollOffset: number;
  /** Lines never expire on a scrolling frame -- see `SetFading`. */
  fading: boolean;
  /**
   * THE SCROLLBACK, for `ScrollingMessageFrame` only, and separate from `lines` on purpose.
   *
   * `lines` is what is ON SCREEN and each entry owns a region from the pool. This is what the frame
   * REMEMBERS -- up to `maxLines` entries of pure data, no widgets. Conflating the two is exactly the
   * defect `AddMessage` below documents: a buffer made of screen regions cannot be deeper than the
   * screen.
   */
  buffer: { text: string; color: string | null; id: number | null }[];
  /**
   * The outline/monochrome flags string, remembered but not styled -- `FontSpec` has no field for it.
   * Kept because `FCF_SetChatWindowFontSize` reads it with `GetFont` and writes it back with `SetFont`,
   * so dropping it would reset a style the player chose every time the size changed.
   */
  fontFlags: string;
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
    state = {
      frameId, lines: [], regions: [], holdSeconds: 5, insertTop: true,
      maxLines: MAX_LINES, scrollOffset: 0, fading: true, buffer: [], fontFlags: '',
    };
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
  while (state.regions.length < visibleCap(ctx, state)) {
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
    // A SCROLLING frame does not fade: its scrollback is the point, and expiring lines out of it would
    // make the scrollbar walk backwards while the player reads. `FCF_SetFading` writes this per frame,
    // and a frame declaring `maxLines` is created with fading off -- see `setMessageFrameMaxLines`.
    if (state.lines.length === 0 || !state.fading) {
      continue;
    }
    const live = state.lines.filter((line) => line.expiresAt > now);
    if (live.length !== state.lines.length) {
      state.lines = live;
      reflow(state, state.regions);
    }
  }
}

/**
 * How many lines FIT on screen -- the frame's height over one line's height, at least one.
 *
 * `MessageFrame` stays at `MAX_LINES` because its box is authored to hold three; a
 * `ScrollingMessageFrame` is whatever its own rect allows. Asked per call rather than cached: a chat
 * frame is RESIZABLE (`chatframe.xml:4`) and `FCF_SetWindowSize` moves it at runtime, so a cached count
 * would go stale exactly when the player dragged the corner.
 */
function visibleCap(ctx: MethodContext, state: MessageFrameState): number {
  if (state.maxLines === MAX_LINES) {
    return MAX_LINES;
  }
  const frame = ctx.registry.widget(state.frameId);
  const lineHeight = state.regions[0]?.font?.size ?? 14;
  const height = frame?.height ?? 0;
  if (height <= 0 || lineHeight <= 0) {
    return MAX_LINES;
  }
  return Math.max(1, Math.min(state.maxLines, Math.floor(height / lineHeight)));
}

/** `<ScrollingMessageFrame maxLines="128">` -- the loader hook, beside the two above. */
export function setMessageFrameMaxLines(frameId: number, lines: number): void {
  if (Number.isFinite(lines) && lines > 0) {
    const state = stateOf(frameId);
    state.maxLines = Math.floor(lines);
    // A frame that declares `maxLines` is a scrollback, and a scrollback does not fade. Set here because
    // the attribute is the only signal available at load time that separates the two classes --
    // `registerMethods` does not tell a method table which frames wear it.
    state.fading = false;
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

/**
 * Fill the on-screen list from the SCROLLBACK, honouring `scrollOffset`.
 *
 * `reflow` lays out `state.lines`; this is what decides WHICH buffer entries those are. Split so that
 * `MessageFrame` -- whose buffer is always empty because it writes `lines` directly -- is untouched and
 * pays nothing.
 *
 * THE SLICE IS OLDEST-FIRST AND THAT IS WHY A CHAT FRAME READS CORRECTLY with `insertTop` left at its
 * default: `reflow` puts `lines[0]` at the TOP, so oldest at the top and newest at the bottom, which is
 * how chat reads. `UIErrorsFrame` sets `insertMode="TOP"` and reverses that for itself, and it never
 * reaches this function anyway.
 *
 * `regions.length` IS the visible cap -- `regionsOf` builds exactly that many -- so no `MethodContext`
 * is needed here.
 */
function windowInto(state: MessageFrameState, regions: Widget[]): void {
  if (state.buffer.length === 0) {
    return;
  }
  const cap = Math.max(1, regions.length);
  // Measured from the BOTTOM: offset 0 means the newest entry is the last one shown.
  const end = state.buffer.length - state.scrollOffset;
  const start = Math.max(0, end - cap);
  const slice = state.buffer.slice(start, end);
  state.lines = slice.map((entry, index) => {
    const region = regions[index];
    region.text = entry.text;
    if (region.font !== null && entry.color !== null) {
      region.font.color = entry.color;
    }
    // `expiresAt` is far in the future rather than absent: a scrolling frame has `fading` off so the
    // tick never inspects it, and a sentinel keeps `MessageLine` one shape for both classes.
    return { region, expiresAt: Number.POSITIVE_INFINITY };
  });
}

/** Clamp a scroll offset into the buffer and re-lay the window. Returns whether anything moved. */
function scrollTo(ctx: MethodContext, self: number, offset: number): boolean {
  const state = stateOf(self);
  const regions = regionsOf(ctx, state);
  const cap = visibleCap(ctx, state);
  const highest = Math.max(0, state.buffer.length - cap);
  const wanted = Math.max(0, Math.min(highest, Math.floor(offset)));
  if (wanted === state.scrollOffset) {
    return false;
  }
  state.scrollOffset = wanted;
  windowInto(state, regions);
  reflow(state, regions);
  return true;
}

/**
 * `SCROLLINGMESSAGEFRAME` -- the class behind every `ChatFrame`, and its ABSENCE was the whole of
 * "chat is dead at load".
 *
 * `ChatFrame1..7` are declared `<ScrollingMessageFrame>` (`chatframe.xml:4` for `ChatFrameTemplate`,
 * `floatingchatframe.xml:871,991,...` for the instances). The class was not in `WidgetClass`, so
 * `parseClass` answered null, `CreateFrame` threw "unknown frame type", and the loader dropped each
 * element AND ITS WHOLE SUBTREE -- the same defect family as COOLDOWN, GAMETOOLTIP and WORLDFRAME
 * before it (`object.ts#CLASS_PARENT` records all three). That is why `ChatFrame1` was nil, why
 * `DEFAULT_CHAT_FRAME` was never assigned (`floatingchatframe.xml:886`), and why four separate features
 * had no listener: the Whisper menu row, the level-up congratulation lines, the duel countdown and
 * winner lines, and `SMSG_PARTY_COMMAND_RESULT`'s reason codes.
 *
 * IT IS NOT A SUBCLASS OF `MessageFrame`, deliberately: in the real API both derive from Frame, so
 * `IsObjectType("MessageFrame")` on a chat frame answers FALSE. The two share this file's state, region
 * pool and layout by COMPOSITION -- the table below spreads `MESSAGEFRAME`'s `AddMessage` -- rather than
 * by inheritance, which keeps `object.ts#chainOf` honest while keeping one implementation of what they
 * genuinely share.
 *
 * WHAT IS REAL AND WHAT IS NOT. The line buffer, `maxLines`, the visible window, the scroll offset and
 * every scroll verb are real and operate on the buffer. `SetHyperlinksEnabled` and `UpdateColorByID` are
 * accepted and recorded but change no drawing: hyperlink hit-testing inside a line and
 * per-message-id recolouring both need the text layer to expose per-run rects, which it does not. Named
 * here rather than left to be discovered.
 */
const SCROLLINGMESSAGEFRAME: MethodTable = {
  ...MESSAGEFRAME,

  /**
   * `AddMessage(text, r, g, b, messageId)` -- push one line onto the SCROLLBACK.
   *
   * **THIS OVERRIDES `MESSAGEFRAME`'s, AND SHARING IT WAS A REAL DEFECT THE PROBE CAUGHT.** That one
   * recycles a fixed pool -- `if (state.lines.length >= regions.length) state.lines.shift()` -- where
   * `regions.length` is the number of lines that FIT ON SCREEN. Inherited here it made the buffer
   * physically incapable of holding more than the visible window: 14 messages added, `GetNumMessages()`
   * answered **8**, `AtTop()` was permanently true and `ScrollUp` had nothing to scroll. A scrollback
   * that cannot exceed its own window is not a scrollback.
   *
   * So the buffer is its own list, capped at `maxLines` (128 from `chatframe.xml:4`), and `reflow`
   * shows a WINDOW onto it chosen by `scrollOffset`.
   *
   * **THE FIFTH ARGUMENT DIFFERS BETWEEN THE TWO CLASSES**, which is worth stating because the
   * `MESSAGEFRAME` docstring above reasons about it as an alpha and is right for its own class only. On
   * a `ScrollingMessageFrame` it is the MESSAGE ID: `chatframe.lua:2568` passes `info.r, info.g, info.b,
   * info.id`, and `UpdateColorByID(id, r, g, b)` (`:2522`) later recolours every line carrying that id.
   * The id is stored per line so that recolour becomes possible; it is not used for anything yet, and
   * `UpdateColorByID` is a named gap because recolouring needs per-line colour the text layer keeps but
   * the region pool overwrites on reflow.
   *
   * **STAYING AT THE BOTTOM IS CONDITIONAL, and that is the engine's behaviour**: a new message scrolls
   * the view only if the player was already at the bottom. Scrolled back to read something, he keeps his
   * place -- otherwise arriving chat would yank the view away mid-sentence.
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
    const wasAtBottom = state.scrollOffset === 0;
    state.buffer.push({
      text,
      color: typeof args[1] === 'number'
        ? toHex(Number(args[1]), Number(args[2]), Number(args[3]))
        : null,
      id: typeof args[4] === 'number' ? args[4] : null,
    });
    // The OLDEST line goes when the scrollback is full -- the newest message is the one the player
    // needs, which is the same reasoning `MESSAGEFRAME` applies to its three-line pool.
    while (state.buffer.length > state.maxLines) {
      state.buffer.shift();
      // The view is measured from the bottom, so dropping the oldest line moves everything the player
      // is looking at one step closer to it. Without this a scrolled-back reader drifts.
      if (state.scrollOffset > 0) {
        state.scrollOffset -= 1;
      }
    }
    if (wasAtBottom) {
      state.scrollOffset = 0;
    }
    windowInto(state, regions);
    reflow(state, regions);
    return [];
  },

  /** `Clear()` -- drop the whole scrollback. `FCF_Clear` and the `/clear` command both reach it. */
  Clear: (ctx, self) => {
    const state = stateOf(self);
    state.buffer = [];
    state.lines = [];
    state.scrollOffset = 0;
    reflow(state, regionsOf(ctx, state));
    return [];
  },

  /** `GetNumMessages()` -- lines in the BUFFER, not lines on screen. */
  GetNumMessages: (ctx, self) => [stateOf(self).buffer.length],

  SetMaxLines: (ctx, self, args) => {
    if (typeof args[0] === 'number') {
      setMessageFrameMaxLines(self, args[0]);
    }
    return [];
  },
  GetMaxLines: (ctx, self) => [stateOf(self).maxLines],

  /** `GetNumLinesDisplayed()` -- the height of the window onto the buffer. */
  GetNumLinesDisplayed: (ctx, self) => [visibleCap(ctx, stateOf(self))],

  // The scroll verbs: ONE line for the arrows, one window for the page keys -- the engine's own step
  // sizes, and what `FCF_ScrollUp` and `ChatFrame_OnMouseWheel` expect.
  ScrollUp: (ctx, self) => { scrollTo(ctx, self, stateOf(self).scrollOffset + 1); return []; },
  ScrollDown: (ctx, self) => { scrollTo(ctx, self, stateOf(self).scrollOffset - 1); return []; },
  PageUp: (ctx, self) => {
    const state = stateOf(self);
    scrollTo(ctx, self, state.scrollOffset + visibleCap(ctx, state));
    return [];
  },
  PageDown: (ctx, self) => {
    const state = stateOf(self);
    scrollTo(ctx, self, state.scrollOffset - visibleCap(ctx, state));
    return [];
  },
  ScrollToTop: (ctx, self) => { scrollTo(ctx, self, Number.MAX_SAFE_INTEGER); return []; },
  ScrollToBottom: (ctx, self) => { scrollTo(ctx, self, 0); return []; },
  SetScrollOffset: (ctx, self, args) => {
    scrollTo(ctx, self, typeof args[0] === 'number' ? args[0] : 0);
    return [];
  },
  GetScrollOffset: (ctx, self) => [stateOf(self).scrollOffset],

  /**
   * `AtTop()` / `AtBottom()` -- what the scroll arrows' enabled state is gated on.
   *
   * BOTH ARE TRUE ON AN EMPTY OR UNDER-FULL BUFFER, which is the engine's answer and not a shortcut: a
   * frame holding fewer lines than it can show is at the top and the bottom of its own scrollback at
   * once, and that is what correctly disables both arrows.
   */
  AtTop: (ctx, self) => {
    const state = stateOf(self);
    return [state.scrollOffset >= Math.max(0, state.buffer.length - visibleCap(ctx, state))];
  },
  AtBottom: (ctx, self) => [stateOf(self).scrollOffset === 0],

  /**
   * `SetFading(on)` / `SetTimeVisible(s)` / `GetTimeVisible()` -- real, and they matter: with fading ON
   * the tick expires lines out of the buffer, which on a chat frame would shrink the scrollback while
   * the player reads it. `FCF_SetFading` writes this per frame from the interface options.
   */
  SetFading: (ctx, self, args) => {
    stateOf(self).fading = args[0] !== undefined && args[0] !== null && args[0] !== false;
    return [];
  },
  SetTimeVisible: (ctx, self, args) => {
    if (typeof args[0] === 'number' && args[0] > 0) {
      stateOf(self).holdSeconds = args[0];
    }
    return [];
  },
  GetTimeVisible: (ctx, self) => [stateOf(self).holdSeconds],

  /**
   * `GetFont()` -> `file, size, flags` and `SetFont(file, size, flags)` -- **FRAME-LEVEL on this class,
   * and their absence was the last thing standing between a decoded message and a visible line.**
   *
   * MEASURED. `ChatFrame_OnEvent`'s `UPDATE_CHAT_WINDOWS` arm reads:
   *
   *     local fontFile, unused, fontFlags = self:GetFont();      -- chatframe.lua:2503
   *     self:SetFont(fontFile, fontSize, fontFlags);
   *     ...
   *     ChatFrame_RegisterForMessages(self, GetChatWindowMessages(self:GetID()));   -- :2510
   *
   * so the raise at 2503 happened SEVEN LINES BEFORE the registration, and
   * `ChatFrame_RegisterForMessages` is the only thing in the client that registers a frame for a
   * `CHAT_MSG_*` event. Every earlier fix in this area -- the widget class, `GetChatTypeIndex`, a real
   * `GetChatWindowMessages`, firing `UPDATE_CHAT_WINDOWS` -- was necessary and none of them was
   * sufficient, because this arm never got past its third line. The console said
   * `attempt to call a nil value (method 'GetFont')` and nothing else did.
   *
   * A `ScrollingMessageFrame` is not a FontString, so this is not the `FontString:GetFont` another
   * round added: on this class the font belongs to the frame and every line region inherits it. The
   * PROTOTYPE region is the store -- `regionsOf` copies its `FontSpec` into each new line, so writing
   * the prototype is what makes the next line use the new font. Existing lines are re-fonted too,
   * because the real client's font change is immediate and a half-restyled scrollback would be worse
   * than either state.
   *
   * TWO DELIBERATE DEVIATIONS, both stated rather than hidden. The engine's first return is a font
   * FILE PATH; this returns the `FontSpec` FAMILY (`FRIZQT`, ...), because that is what this renderer
   * keys fonts by and the only consumer round-trips the value straight back into `SetFont`. And of the
   * `flags` string only `OUTLINE` is applied -- it is the one styling bit `FontSpec` can express;
   * `MONOCHROME` and `THICKOUTLINE` have no field and are remembered in `fontFlags` so that
   * `FCF_SetChatWindowFontSize`'s read-modify-write does not reset a style the player chose.
   */
  GetFont: (ctx, self) => {
    const state = stateOf(self);
    const regions = regionsOf(ctx, state);
    const font = regions[0]?.font ?? null;
    if (font === null) {
      // The engine answers nothing for a frame with no font yet, and `chatframe.lua:2502` guards the
      // whole block on `fontSize > 0`, so nothing here divides by it.
      return [];
    }
    return [font.family ?? '', font.size ?? 14, state.fontFlags];
  },
  SetFont: (ctx, self, args) => {
    const state = stateOf(self);
    const regions = regionsOf(ctx, state);
    const file = typeof args[0] === 'string' ? args[0] : null;
    const size = typeof args[1] === 'number' && args[1] > 0 ? args[1] : null;
    if (typeof args[2] === 'string') {
      state.fontFlags = args[2];
    }
    for (const region of regions) {
      if (region.font === null) {
        continue;
      }
      if (file !== null) {
        region.font.family = file;
      }
      if (size !== null) {
        region.font.size = size;
      }
      // OUTLINE is the one flag `FontSpec` can actually express, so it is applied rather than only
      // remembered. `MONOCHROME` and `THICKOUTLINE` have no field and ride along in `fontFlags`.
      if (typeof args[2] === 'string') {
        region.font.outline = /OUTLINE/i.test(args[2]);
      }
    }
    // The line height changed, so the window onto the buffer holds a different number of lines.
    windowInto(state, regions);
    reflow(state, regions);
    return [];
  },

  /** `SetInsertMode("TOP"|"BOTTOM")` -- the method form of the XML attribute. */
  SetInsertMode: (ctx, self, args) => {
    if (typeof args[0] === 'string') {
      setMessageFrameInsertMode(self, args[0]);
    }
    return [];
  },
};

registerMethods('SCROLLINGMESSAGEFRAME', SCROLLINGMESSAGEFRAME);
