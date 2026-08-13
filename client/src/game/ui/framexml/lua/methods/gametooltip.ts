/**
 * GAMETOOLTIP -- the frame type whose absence was blocking FOUR separate things the owner reported.
 *
 * `GameTooltip` is declared in the client's own files and always has been:
 *
 *     GameTooltipTemplate.xml:3  <GameTooltip name="GameTooltipTemplate" frameStrata="TOOLTIP"
 *                                            clampedToScreen="true" hidden="true" virtual="true">
 *     GameTooltip.xml:9          <GameTooltip name="GameTooltip" frameStrata="TOOLTIP" hidden="true"
 *                                            parent="UIParent" inherits="GameTooltipTemplate">
 *
 * and `GameTooltip.xml` is entry 19 of `FrameXML.toc`, so it loads early. `parseClass('GameTooltip')`
 * returned null, `CreateFrame` threw "unknown frame type", and `loader.ts` dropped the element AND ITS
 * WHOLE SUBTREE -- for `GameTooltip` itself and for all three `ShoppingTooltip`s. The global was therefore
 * NIL, and everything that touches it raised:
 *
 *  - **the spellbook had no hover description** -- `SpellButton_OnEnter` (`spellbookframe.lua:332-339`);
 *  - **the action bar had no tooltip** -- `ActionButton_SetTooltip` (`actionbutton.lua:419-434`);
 *  - **the micro buttons had none** -- `GameTooltip_AddNewbieTip` (`mainmenubarmicrobuttons.xml:14`);
 *  - **an EMPTY action slot could not be dropped onto**, because `ActionButton_ShowGrid` reveals the
 *    empty buttons and `ActionButton_Update`'s LAST statement is `if ( GameTooltip:GetOwner() == self )`
 *    (`actionbutton.lua:265`), which raised and took the reveal with it.
 *
 * ## Which methods are real, and how that was decided
 *
 * Measured, the way `methods/cooldown.ts` measured Cooldown's: every `GameTooltip:<Method>` call across
 * all 264 loaded manifest files was counted. The head of that list is
 *
 *     SetOwner 207, SetText 160, AddLine 139, Hide 124, Show 91, IsOwned 30, AddDoubleLine 21,
 *     GetOwner 9, AddTexture 9, SetMinimumWidth 6, AppendText 5, ClearLines 1, FadeOut 1,
 *     SetAction 1, SetSpell 1, NumLines (via SetTooltipMoney)
 *
 * and a long tail of `Set<Thing>Item`/`SetUnitAura`/`SetHyperlink` filling calls for subsystems this
 * client has no wire path for at all (bags, mail, the auction house, trade, LFG rewards). The tail is NOT
 * written: each of those needs an item or aura feed that does not exist, and a tooltip that showed an
 * invented item is worse than one that shows nothing. They are absent rather than stubbed, so a call to
 * one raises where the load report can see it -- the same treatment `api/spells.ts` gives `HasPetSpells`.
 *
 * `Show`, `Hide`, `SetPoint`, `ClearAllPoints`, `SetBackdropColor`, `SetBackdropBorderColor`,
 * `SetFrameLevel`, `GetName`, `SetScript` are all inherited Frame/Region methods that already existed --
 * nothing below re-declares them. In particular **`Show` is deliberately not overridden**: every mutation
 * here re-sizes the frame immediately, so there is no deferred layout for `Show` to flush.
 *
 * ## How a tooltip is DRAWN, which is the part that needed no new machinery
 *
 * A `GameTooltip` is a `<Backdrop>` plus a stack of `<FontString>`s, and the widget layer draws both
 * already. `GameTooltipTemplate` authors **eight** line slots -- `$parentTextLeft1..8` and
 * `$parentTextRight1..8` -- each `hidden="true"`, each anchored to the one above it
 * (`TOPLEFT` to the previous line's `BOTTOMLEFT`, offset `0,-2`), with line 1 at `TOPLEFT 10,-10` of the
 * tooltip. So filling a tooltip is: write the text, show the slots, hide the rest, and give the FRAME a
 * width and height that contain them. That is what `resize` below does, and it is why the anchor chain
 * must be filled from line 1 upward -- a shown line anchored to a hidden one is the unplaceable-node case
 * `ui/layout.ts#unplaceableNodes` puts in the window's corner.
 *
 * The regions are reached by NAME, through `registry.nameOf(self)` + a suffix, which is exactly how the
 * client's own Lua reaches them (`_G[self:GetName().."TextLeft1"]`, `gametooltip.lua:81`). That matters
 * for the `ShoppingTooltip`s: they share the template, so a hard-coded `GameTooltipTextLeft1` would have
 * three frames writing into one.
 */
import { MethodContext, MethodTable, registerMethods } from '../object';
import { Widget } from '../../../widget';
import { ensureFont, notImplemented, warnOnce, widgetOf } from './region';
import { getAction } from '../api/actions';
import { getSpellbook } from '../api/spells';
import { measureText } from '../../../text';

/**
 * How many lines a tooltip can hold: the eight `$parentTextLeft<n>` slots `GameTooltipTemplate` authors.
 *
 * The real engine CREATES more `FontString`s past the authored eight when a tooltip needs them. This one
 * does not, and a ninth line is dropped with a one-time warning rather than silently: none of the three
 * consumers built here comes near eight (a spell tooltip is name + rank + cost + range + description), so
 * growing the stack would be machinery for a case nothing reaches, and a warning names it if one ever does.
 */
const MAX_LINES = 8;

/**
 * The tooltip's inner padding and line gap, in LOGICAL UNITS -- both read straight off the template.
 *
 * `$parentTextLeft1` is anchored `TOPLEFT` at `AbsDimension x="10" y="-10"` (gametooltiptemplate.xml:18-24)
 * and each later line at `0,-2` from the one above (`:36-42`), so the top and left insets are 10 and the
 * gap is 2. The RIGHT and BOTTOM insets are not authored anywhere -- nothing anchors to them -- so 10 is
 * taken by symmetry with the left and top, which is OURS and unsourced.
 */
const INSET = 10;
const LINE_GAP = 2;

/**
 * The gap between a line's left and right text, from the template: `$parentTextRight<n>` anchors its RIGHT
 * to the matching left string's LEFT at `AbsDimension x="40"` (gametooltiptemplate.xml:26-33).
 */
const DOUBLE_LINE_GAP = 40;

/**
 * Where a long line wraps, in logical units.
 *
 * OURS and UNSOURCED. The real engine decides a tooltip's width from its content and a minimum, and
 * nothing in the game's own files states what that maximum is. 260 units is about a third of the 1024-unit
 * reference width, which is roughly what a real spell tooltip occupies; it is applied ONLY to a line the
 * caller asked to wrap (`AddLine`'s 5th argument, `SetText`'s 6th) plus the description line `SetSpell`
 * and `SetAction` add, so an unwrapped label is measured and drawn at its true width exactly as before.
 */
const WRAP_UNITS = 260;

interface TooltipState {
  /** The frame id `SetOwner` was given, or null. What `GetOwner`/`IsOwned` answer. */
  owner: number | null;
  /** How many line slots are currently filled. What `NumLines` answers. */
  lines: number;
  /** `SetMinimumWidth`'s value, in logical units. 0 for none. */
  minWidth: number;
}

/**
 * Per-tooltip state, keyed by the WIDGET.
 *
 * A `WeakMap` on the widget rather than a map of frame ids, for the reason `region.ts#userPlaced` gives:
 * ids are minted per registry, so a module-level id map would leak one runtime's tooltips into the next
 * one's by number collision -- and a torn-down and rebuilt screen is the ordinary case here.
 */
const stateByWidget = new WeakMap<Widget, TooltipState>();

function stateOf(widget: Widget): TooltipState {
  let state = stateByWidget.get(widget);
  if (state === undefined) {
    state = { owner: null, lines: 0, minWidth: 0 };
    stateByWidget.set(widget, state);
  }
  return state;
}

/** `r, g, b` floats to the `#rrggbb` a `FontSpec.color` holds. */
function toHex(r: number, g: number, b: number): string {
  const byte = (value: number) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    return Math.round(clamped * 255).toString(16).padStart(2, '0');
  };
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * One of the tooltip's own named regions -- `TextLeft3`, `TextRight1` -- or null.
 *
 * Null is a real answer and not a failure: a `GameTooltip` created by `CreateFrame` with no template has
 * no line slots at all, and an addon does that.
 */
function regionOf(ctx: MethodContext, self: number, suffix: string): Widget | null {
  const name = ctx.registry.nameOf(self);
  if (name === null) {
    return null;
  }
  const id = ctx.registry.byName(name + suffix);
  return id === null ? null : ctx.registry.widget(id);
}

/** A line slot's own measured size, in logical units. `{0,0}` for a slot that is not shown. */
function lineSize(region: Widget | null): { width: number; height: number } {
  if (region === null || !region.shown || region.text === '') {
    return { width: 0, height: 0 };
  }
  // Scale 1: a widget's size is in logical units and the live layout scale divides out. Same call and
  // same argument `region.ts`'s `GetWidth`/`GetStringWidth` make, so the two cannot disagree about how
  // wide a string is.
  return measureText(region.text, ensureFont(region), 1);
}

/**
 * Give the tooltip a rect that contains its filled lines.
 *
 * The frame declares no `<Size>` and no opposing anchors -- `SetOwner` anchors ONE corner -- so without
 * this it would resolve to a zero rect and draw its backdrop as nothing. Called after every mutation
 * rather than from `Show`, so a tooltip that is already up and gains a line re-sizes at once, which is
 * what `mainmenubarmicrobuttons.xml:15-19` does (`AddNewbieTip`, then `AddLine`, then `Show`).
 */
function resize(ctx: MethodContext, self: number): void {
  const widget = widgetOf(ctx, self);
  const state = stateOf(widget);
  let width = 0;
  let height = 0;
  for (let line = 1; line <= state.lines; line += 1) {
    const left = lineSize(regionOf(ctx, self, `TextLeft${line}`));
    const right = lineSize(regionOf(ctx, self, `TextRight${line}`));
    const lineWidth = right.width > 0 ? left.width + DOUBLE_LINE_GAP + right.width : left.width;
    width = Math.max(width, lineWidth);
    height += Math.max(left.height, right.height) + (line > 1 ? LINE_GAP : 0);
  }
  widget.width = Math.max(state.minWidth, width + INSET * 2);
  widget.height = height + INSET * 2;
  placeRightColumns(ctx, self, state.lines, widget);
}

/**
 * THE RIGHT COLUMN IS THE ENGINE'S TO PLACE, and honouring its authored anchor literally is what drew
 * text over text -- the owner's second screenshot, "Racial Passive" on top of "Mace Specialization".
 *
 * `$parentTextRight<n>` is authored `point="RIGHT" relativeTo="$parentTextLeft<n>"
 * relativePoint="LEFT" x="40"` (gametooltiptemplate.xml:26-33), i.e. its RIGHT edge sits 40 units to the
 * right of the LEFT string's LEFT edge -- so on any tooltip whose name is wider than 40 units the two
 * strings occupy the same space. That anchor cannot be what the client shows; it is the placeholder the
 * engine overwrites, and the 40 survives as the MINIMUM GAP, which is exactly how `resize` above already
 * uses it (`DOUBLE_LINE_GAP`, and the frame is widened to `left + 40 + right`).
 *
 * So the engine's rule, applied here: the right column is flush with the tooltip's right inset, on the
 * same top edge as its own left string. Two anchors, and the pair relies on `layout.ts#resolveOne`'s
 * documented precedence -- `TOP` gives the top EDGE and a centre-x that is then ignored, `RIGHT` gives the
 * right EDGE and a centre-y that is then ignored -- so neither axis is over-constrained.
 *
 * Same class of override as the `<BarTexture>` one `widget.ts#drawList` documents: a region whose geometry
 * the engine owns rather than the document. Done in `resize` because the tooltip's width is what the right
 * edge is measured from, and that width is only known once every line has been measured.
 */
function placeRightColumns(
  ctx: MethodContext,
  self: number,
  lines: number,
  tooltip: Widget,
): void {
  for (let line = 1; line <= lines; line += 1) {
    const right = regionOf(ctx, self, `TextRight${line}`);
    const left = regionOf(ctx, self, `TextLeft${line}`);
    if (right === null || left === null || !right.shown || right.text === '') {
      continue;
    }
    right.setAnchors(
      { point: 'TOP', relativeTo: left.id, relativePoint: 'TOP', x: 0, y: 0 },
      { point: 'RIGHT', relativeTo: tooltip.id, relativePoint: 'RIGHT', x: -INSET, y: 0 },
    );
  }
}

/** Hide every line slot from `from` upward, so a shorter tooltip does not keep the last one's tail. */
function clearFrom(ctx: MethodContext, self: number, from: number): void {
  for (let line = from; line <= MAX_LINES; line += 1) {
    const left = regionOf(ctx, self, `TextLeft${line}`);
    const right = regionOf(ctx, self, `TextRight${line}`);
    if (left !== null) {
      left.text = '';
      left.shown = false;
    }
    if (right !== null) {
      right.text = '';
      right.shown = false;
    }
  }
}

/**
 * Write one side of one line and show it. Returns false when the slot does not exist.
 *
 * A colour of `undefined` leaves the region's authored font colour alone -- `GameTooltipHeaderText` and
 * `GameTooltipText` are both `<Color r="1.0" g="1.0" b="1.0"/>` (`fontstyles.xml:247-255`), so a caller
 * that passes no colour gets white, which is the engine's own default for a tooltip line.
 */
function writeSide(
  ctx: MethodContext,
  self: number,
  suffix: string,
  text: string,
  colour: { r: number; g: number; b: number } | undefined,
  wrap: boolean,
): boolean {
  const region = regionOf(ctx, self, suffix);
  if (region === null) {
    return false;
  }
  region.text = text;
  region.shown = true;
  const font = ensureFont(region);
  if (colour !== undefined) {
    font.color = toHex(colour.r, colour.g, colour.b);
  }
  // Only ever SET, never cleared back to undefined: a slot reused for an unwrapped line would otherwise
  // keep the previous tooltip's wrap. `wrapWidth` of undefined is "measure on one line".
  font.wrapWidth = wrap ? WRAP_UNITS : undefined;
  return true;
}

/**
 * LUA TRUTHINESS for a boolean argument -- everything except nil and false.
 *
 * Not `=== true`, and self-review caught the difference LIVE rather than on paper. FrameXML spells its
 * booleans as `1` at least as often as `true`, and the tooltip's own callers are the proof:
 * `GameTooltip_AddNewbieTip` passes `1` for `AddLine`'s wrap flag and `1, 1` for `SetText`'s alpha and
 * wrap (`gametooltip.lua:203,206`). A `=== true` test read those as false, so the micro button's newbie
 * line -- a 147-character sentence -- was measured on ONE line and the tooltip came out **801 logical
 * units wide**, nearly the whole 1024-unit reference width. Measured on :3000; that is what this exists
 * for.
 */
function flag(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** `(r, g, b)` from an argument triple, or undefined when the first of them is absent. */
function colourArg(args: unknown[], at: number): { r: number; g: number; b: number } | undefined {
  if (typeof args[at] !== 'number') {
    return undefined;
  }
  return { r: Number(args[at]), g: Number(args[at + 1] ?? 1), b: Number(args[at + 2] ?? 1) };
}

/** Append a line, returning the 1-based index written, or 0 when the tooltip is full. */
function appendLine(
  ctx: MethodContext,
  self: number,
  left: string,
  right: string | null,
  leftColour: { r: number; g: number; b: number } | undefined,
  rightColour: { r: number; g: number; b: number } | undefined,
  wrap: boolean,
): number {
  const state = stateOf(widgetOf(ctx, self));
  if (state.lines >= MAX_LINES) {
    warnOnce(
      `GameTooltip: more than ${MAX_LINES} lines -- GameTooltipTemplate authors exactly that many `
      + '$parentTextLeft<n> slots and this runtime does not create more, so the extra lines are dropped',
    );
    return 0;
  }
  const line = state.lines + 1;
  if (!writeSide(ctx, self, `TextLeft${line}`, left, leftColour, wrap)) {
    return 0;
  }
  if (right !== null) {
    writeSide(ctx, self, `TextRight${line}`, right, rightColour, false);
  }
  state.lines = line;
  return line;
}

/**
 * The anchor `SetOwner`'s `anchorType` asks for, as a `(tooltipPoint, ownerPoint)` pair.
 *
 * The names are the engine's `ANCHOR_*` strings. The pairs are the obvious reading of each name -- the
 * tooltip's opposite corner meets the owner's named one, so `ANCHOR_RIGHT` puts the tooltip's left edge
 * against the owner's right edge. That reading is OURS: no file in the manifest states the mapping, and
 * `ANCHOR_NONE` is the only one whose meaning the client's own Lua demonstrates
 * (`GameTooltip_SetDefaultAnchor` passes it and then calls `SetPoint` itself, `gametooltip.lua:72-76`).
 */
const ANCHORS: Record<string, [string, string]> = {
  ANCHOR_TOPLEFT: ['BOTTOMLEFT', 'TOPLEFT'],
  ANCHOR_LEFT: ['TOPRIGHT', 'TOPLEFT'],
  ANCHOR_BOTTOMLEFT: ['TOPLEFT', 'BOTTOMLEFT'],
  ANCHOR_TOPRIGHT: ['BOTTOMRIGHT', 'TOPRIGHT'],
  ANCHOR_RIGHT: ['TOPLEFT', 'TOPRIGHT'],
  ANCHOR_BOTTOMRIGHT: ['TOPRIGHT', 'BOTTOMRIGHT'],
  ANCHOR_TOP: ['BOTTOM', 'TOP'],
  ANCHOR_BOTTOM: ['TOP', 'BOTTOM'],
};

const GAMETOOLTIP: MethodTable = {
  /**
   * `SetOwner(owner, anchorType[, xOffset, yOffset])`.
   *
   * CLEARS THE TOOLTIP as well as recording the owner, which is the engine's behaviour and is load-bearing
   * here: `mainmenubarmicrobuttons.xml:14-16` calls `GameTooltip_AddNewbieTip` (which ends in `SetOwner` +
   * `SetText`) and then `GameTooltip:AddLine(" ")`, so without a reset every hover would append another
   * blank line to the previous hover's tooltip.
   *
   * `ANCHOR_NONE` positions nothing: `GameTooltip_SetDefaultAnchor` passes it precisely so it can call
   * `SetPoint("BOTTOMRIGHT", "UIParent", ...)` itself on the next line (`gametooltip.lua:72-76`). Every
   * other name re-anchors the tooltip to the owner, replacing whatever a previous owner left behind --
   * hence `setAnchors` with the single anchor rather than an additive `SetPoint`.
   */
  SetOwner: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const state = stateOf(widget);
    state.owner = ctx.frameIdOf(args[0]);
    state.lines = 0;
    state.minWidth = 0;
    clearFrom(ctx, self, 1);
    resize(ctx, self);

    /**
     * THE OLD OWNER'S ANCHOR GOES FIRST, unconditionally -- and leaving it in place was a real defect,
     * caught by measuring the micro-button tooltip live rather than by reading this code.
     *
     * `GameTooltip_SetDefaultAnchor` calls `SetOwner(parent, "ANCHOR_NONE")` and then `SetPoint(
     * "BOTTOMRIGHT", "UIParent", ...)` (`gametooltip.lua:72-76`), which only makes sense if `SetOwner`
     * cleared the points -- otherwise the tooltip would end up carrying whatever the last owner left.
     * And that is exactly what happened: measured on :3000, hovering `ActionButton1` (`ANCHOR_RIGHT`, a
     * TOPLEFT anchor) and then a micro button (`ANCHOR_NONE` + a BOTTOMRIGHT `SetPoint`) left the frame
     * with BOTH, and two OPPOSING anchors make `ui/layout.ts#resolveAnchors` DERIVE the rect -- so the
     * tooltip stretched to **801 units wide** and the width computed by `resize` was ignored.
     */
    widget.setAnchors();

    const anchorType = String(args[1] ?? 'ANCHOR_NONE').toUpperCase();
    if (anchorType === 'ANCHOR_NONE') {
      // Positioned by the caller on its next line; see above.
      return [];
    }
    const pair = ANCHORS[anchorType];
    if (pair === undefined) {
      // `ANCHOR_CURSOR` is the notable one: it needs the live pointer, which this object model has no
      // route to (the router is `ui/input.ts` and nothing in `MethodContext` reaches it). Named rather
      // than silently defaulted, because a tooltip in the wrong place is a visible defect.
      warnOnce(
        `GameTooltip:SetOwner: anchor type '${anchorType}' is not implemented -- the tooltip is left `
        + 'unanchored, which puts it at the window\'s top-left corner if anything shows it',
      );
      return [];
    }
    const ownerWidget = state.owner === null ? null : ctx.registry.widget(state.owner);
    if (ownerWidget === null) {
      return [];
    }
    widget.setAnchors({
      point: pair[0] as never,
      relativePoint: pair[1] as never,
      relativeTo: ownerWidget.id,
      x: Number(args[2] ?? 0),
      y: Number(args[3] ?? 0),
    });
    return [];
  },

  /**
   * `GetOwner()` -> the owner's frame table, or nil.
   *
   * The PERMANENT wrapper (`ctx.wrapper`), which the registry owns -- the comparison the client makes is
   * `GameTooltip:GetOwner() == self` (`actionbutton.lua:265`), so it has to be the same Lua table the
   * caller is holding and not a fresh one.
   */
  GetOwner: (ctx, self) => {
    const owner = stateOf(widgetOf(ctx, self)).owner;
    return [owner === null ? null : ctx.wrapper(owner)];
  },

  /** `IsOwned(frame)` -> whether that frame is the current owner. */
  IsOwned: (ctx, self, args) => {
    const owner = stateOf(widgetOf(ctx, self)).owner;
    return [owner !== null && owner === ctx.frameIdOf(args[0])];
  },

  NumLines: (ctx, self) => [stateOf(widgetOf(ctx, self)).lines],

  ClearLines: (ctx, self) => {
    stateOf(widgetOf(ctx, self)).lines = 0;
    clearFrom(ctx, self, 1);
    resize(ctx, self);
    return [];
  },

  /**
   * `SetText(text, r, g, b, alpha, textWrap)` -- REPLACES the tooltip with one line.
   *
   * The `alpha` argument (slot 4) is dropped: `FontSpec.color` is an `#rrggbb` string with nowhere to put
   * a channel, the same reason `region.ts`'s `FONTSTRING.SetTextColor` drops it.
   */
  SetText: (ctx, self, args) => {
    const state = stateOf(widgetOf(ctx, self));
    state.lines = 0;
    clearFrom(ctx, self, 1);
    appendLine(ctx, self, String(args[0] ?? ''), null, colourArg(args, 1), undefined, flag(args[5]));
    resize(ctx, self);
    return [];
  },

  /** `AddLine(text, r, g, b, wrapText)`. */
  AddLine: (ctx, self, args) => {
    appendLine(ctx, self, String(args[0] ?? ''), null, colourArg(args, 1), undefined, flag(args[4]));
    resize(ctx, self);
    return [];
  },

  /**
   * `AddDoubleLine(textLeft, textRight, rL, gL, bL, rR, gR, bR)` -- one line, both columns.
   *
   * The right column is never wrapped: it is anchored by its RIGHT edge to the left string's LEFT
   * (gametooltiptemplate.xml:26-33), so a wrapped right column would grow leftwards over the left one.
   */
  AddDoubleLine: (ctx, self, args) => {
    appendLine(
      ctx,
      self,
      String(args[0] ?? ''),
      String(args[1] ?? ''),
      colourArg(args, 2),
      colourArg(args, 5),
      false,
    );
    resize(ctx, self);
    return [];
  },

  /** `AppendText(text)` -- adds to the END of the last line, without starting a new one. */
  AppendText: (ctx, self, args) => {
    const state = stateOf(widgetOf(ctx, self));
    if (state.lines === 0) {
      return [];
    }
    const region = regionOf(ctx, self, `TextLeft${state.lines}`);
    if (region !== null) {
      region.text += String(args[0] ?? '');
    }
    resize(ctx, self);
    return [];
  },

  SetMinimumWidth: (ctx, self, args) => {
    stateOf(widgetOf(ctx, self)).minWidth = Number(args[0] ?? 0);
    resize(ctx, self);
    return [];
  },

  /**
   * `SetSpell(spellbookSlot, bookType)` -> true when the tooltip was filled.
   *
   * The RETURN VALUE IS LOAD-BEARING and it is not a courtesy: `SpellButton_OnEnter` uses it to decide
   * whether to arm `self.UpdateTooltip` (`spellbookframe.lua:335-339`), and the same shape appears in
   * `ActionButton_SetTooltip`. It reports whether there is a spell in that slot, which is what the engine's
   * own answer means.
   *
   * **AND IT MUST SHOW THE TOOLTIP ITSELF.** Neither `SpellButton_OnEnter` nor `ActionButton_SetTooltip`
   * ever calls `GameTooltip:Show()` -- they call `SetOwner` and then this, and nothing else. So the filling
   * methods are where the engine reveals the frame, and a version of this that only wrote the lines would
   * leave both hover paths silently invisible.
   *
   * The ARGUMENT is a spellbook SLOT and not a spell id -- `SpellBook_GetSpellID` returns a slot
   * (`spellbookframe.lua:591-601`), and `api/spells.ts`'s whole surface is indexed the same way, so this
   * goes through the same pushed snapshot every other spellbook getter reads.
   */
  SetSpell: (ctx, self, args) => {
    const slot = Number(args[0]);
    const bookType = args[1];
    if (typeof bookType === 'string' && bookType !== 'spell') {
      // The pet book. `api/spells.ts` answers null for every getter on it for the same reason: nothing in
      // this client decodes `SMSG_PET_SPELLS`.
      return [false];
    }
    const entry = Number.isFinite(slot) && slot >= 1
      ? getSpellbook(ctx.vm).all[slot - 1] ?? null
      : null;
    if (entry === null) {
      return [false];
    }
    fillSpellLines(ctx, self, entry.name, entry.subName, entry.description);
    return [true];
  },

  /**
   * `SetAction(actionSlot)` -> true when the tooltip was filled. See `SetSpell` for why it shows itself.
   *
   * An EMPTY slot answers false and shows nothing, which is what makes `ActionButton_ShowGrid`'s revealed
   * empty buttons tooltip-free while still being valid drop targets.
   */
  SetAction: (ctx, self, args) => {
    const action = Number(args[0]);
    const snapshot = Number.isFinite(action) ? getAction(ctx.vm, action) : null;
    if (snapshot === null || snapshot.spellId === 0) {
      return [false];
    }
    fillSpellLines(ctx, self, snapshot.name, snapshot.subName, snapshot.description);
    return [true];
  },

  /**
   * `FadeOut()` -- one call site, `GameTooltip_HideResetCursor` (`gametooltip.lua:366-368`).
   *
   * HIDES IMMEDIATELY. The real engine fades the frame's alpha out over `TOOLTIP_FADE_TIME`; this runtime
   * has no per-frame alpha animator, so the tooltip disappears at once instead of over ~0.2 s. A stated
   * deviation rather than a gap -- the outcome (the tooltip goes away) is right and only the transition is
   * missing, so `notImplemented` would leave a tooltip stuck on screen, which is strictly worse.
   */
  FadeOut: (ctx, self) => {
    widgetOf(ctx, self).shown = false;
    return [];
  },

  /**
   * Registered so the class duck-types, with a real reason for each.
   *
   * `AddTexture` (9 call sites) would need a texture slot per line; `GameTooltipTemplate` authors ten
   * `$parentTexture<n>` regions for it, but every one of its nine callers is an ITEM or aura tooltip whose
   * filling method is not written either, so the icon would have nothing to sit beside.
   */
  AddTexture: notImplemented(
    'AddTexture',
    'GameTooltipTemplate\'s ten $parentTexture<n> slots are not wired to the line stack, and all nine '
      + 'call sites are item or aura tooltips whose own Set* method is absent too',
  ),
  /**
   * `IsUnit`/`IsEquippedItem` are read by `GameTooltip.xml`'s own `<OnTooltipSetUnit>` and
   * `<OnTooltipSetItem>` handlers (`gametooltip.xml:16,23`). Those fire only from `SetUnit`/`SetItem`
   * paths, which are absent -- so neither is reachable today, and both are declared rather than assumed
   * unreachable.
   */
  IsUnit: notImplemented(
    'IsUnit',
    'no Set* method here fills a UNIT tooltip, so the tooltip never has a unit to compare against',
    [false],
  ),
  IsEquippedItem: notImplemented(
    'IsEquippedItem',
    'there is no item feed in this client, so no tooltip ever holds an item',
    [false],
  ),
};

/**
 * The three lines a spell tooltip has here: NAME (header) with its RANK on the right, then the
 * description, then show.
 *
 * Shared by `SetSpell` and `SetAction` because a spell is a spell: the real client's two paths differ in
 * how they find the spell and then build the same tooltip. What the real client also puts here and this
 * does NOT -- stated rather than approximated -- is the cast time, the power cost, the range and the
 * cooldown line. Each of those has its own format string and its own unit convention, and this round's
 * report is about the description being ABSENT (the owner's "нет описаний после наведения"), so the two
 * lines that answer that are the two that are written.
 *
 * Line 1 uses the slot's authored `GameTooltipHeaderText` colour (white) rather than a colour of its own:
 * the real client colours a spell name by whether it is castable, which needs the usability evaluation
 * `ActionButton_UpdateUsable` does and which this does not repeat.
 */
function fillSpellLines(
  ctx: MethodContext,
  self: number,
  name: string,
  subName: string,
  description: string,
): void {
  const state = stateOf(widgetOf(ctx, self));
  state.lines = 0;
  clearFrom(ctx, self, 1);
  // The rank goes in the RIGHT column of line 1, which is where the real client puts it and what the
  // template's `$parentTextRight1` slot exists for. `''` -- a rankless spell -- gets no right column at
  // all rather than an empty one, so the line measures at just its name.
  appendLine(ctx, self, name, subName !== '' ? subName : null, undefined, undefined, false);
  if (description !== '') {
    // WRAPPED: a description is a sentence, not a label. `NORMAL_FONT_COLOR`'s gold is the real client's
    // colour for a tooltip body; hard-coded here as (1, 0.82, 0) rather than read from the Lua global,
    // because a method table has no reason to depend on which globals a manifest happened to define.
    appendLine(ctx, self, description, null, { r: 1, g: 0.82, b: 0 }, undefined, true);
  }
  resize(ctx, self);
  widgetOf(ctx, self).shown = true;
}

registerMethods('GAMETOOLTIP', GAMETOOLTIP);
