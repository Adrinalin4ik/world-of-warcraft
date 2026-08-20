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
import { layoutScale, measureText } from '../../../text';
import { getItemTooltipSource, ItemTooltipInfo, ItemTooltipSource } from '../api/items';

/**
 * The eight `$parentTextLeft<n>` slots `GameTooltipTemplate` authors -- and no longer the ceiling.
 *
 * **THIS FILE USED TO STOP AT EIGHT AND ARGUE THAT NOTHING WOULD REACH IT.** The argument was "a spell
 * tooltip is name + rank + cost + range + description", and it held until the item body landed: a plain
 * helm is item level, binding, slot, armour, two stats, a blank, the requirement, durability, the
 * flavour text and the sell price -- ELEVEN lines under the name. Capped at eight, the fix for "items
 * have no description" would have shown two thirds of one and printed a warning.
 *
 * So the stack GROWS, which is what the real engine does: it creates further `FontString`s past the
 * authored eight on demand. `ensureLine` below does exactly that, copying the authored slots' font and
 * continuing their anchor chain.
 */
const AUTHORED_LINES = 8;

/**
 * The ceiling on a grown stack. OURS -- the engine has no documented limit.
 *
 * It exists only so a runaway caller cannot mint FontStrings without bound; 30 is comfortably past the
 * longest real item tooltip (a socketed epic with three effects is high teens) and a line past it is
 * dropped with the same one-time warning the hard cap used to give.
 */
const MAX_LINES = 30;

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

  /**
   * The NAME and LINK of whatever `Set<Thing>Item` last filled this tooltip -- what
   * `GameTooltip:GetItem()` answers. About the tooltip's CURRENT CONTENTS, not about a widget, which
   * is why they live here and are cleared by `SetOwner`.
   */
  itemName?: string | null;
  itemLink?: string | null;
  /**
   * The anchor `SetOwner` was given, kept so `GetAnchorType` can answer it. Not new state -- the value
   * was already received and already mapped through `ANCHORS`; it was simply thrown away.
   */
  anchorType?: string;
}

/**
 * Per-tooltip state, keyed by the WIDGET.
 *
 * A `WeakMap` on the widget rather than a map of frame ids, for the reason `region.ts#userPlaced` gives:
 * ids are minted per registry, so a module-level id map would leak one runtime's tooltips into the next
 * one's by number collision -- and a torn-down and rebuilt screen is the ordinary case here.
 */
const stateByWidget = new WeakMap<Widget, TooltipState>();

/**
 * Each line slot's colour as its document authored it, so an uncoloured line can be restored to it.
 *
 * A `WeakMap` on the WIDGET for the reason `stateByWidget` gives: frame ids are minted per registry, so
 * a module-level id map would leak one runtime's slots into the next one's by number collision.
 */
const AUTHORED_COLOURS = new WeakMap<Widget, string>();

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
  // **THE LIVE LAYOUT SCALE, NOT 1, AND THAT WAS THE OWNER'S TOOLTIP OVERFLOW.**
  //
  // A widget's size is in logical units and the scale divides out again, so scale 1 looks harmless --
  // and it is, for an unwrapped label. For a WRAPPED one it is not: `wrapLines` measures against a
  // device-pixel budget, so the same 260-unit `wrapWidth` breaks the string differently at a different
  // density, and the widest resulting line differs. Measured live at 1382x911 (scale 1.18620) on
  // Eviscerate's real description: the raster broke after "combo" and gave a widest line of **259.43**
  // units, while this call at scale 1 broke after "per" and reported **221.08**. `resize` then sized
  // the frame from 221.08 + 20, so the body was drawn 28.35 units PAST the frame's right edge -- "the
  // first body line reaches and passes the right edge", exactly as reported. The frame and the raster
  // have to be measured at one scale, and the raster's is the one that is on screen.
  //
  // `region.ts`'s `GetWidth`/`GetStringWidth` still answer at scale 1; that asymmetry is named there.
  return measureText(region.text, ensureFont(region), layoutScale());
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
  /**
   * A COLOURLESS LINE GOES BACK TO THE SLOT'S AUTHORED COLOUR, and it used not to -- it kept whatever
   * the LAST tooltip left in that slot.
   *
   * Caught in a screenshot, not on paper: after an item tooltip had painted its `Use:` line green in
   * slot 4, a following tooltip's uncoloured line 4 drew green too. The comment below is still right
   * about the DEFAULT (`GameTooltipHeaderText`/`GameTooltipText` are both white, `fontstyles.xml:247-255`);
   * what was wrong is that "leave the font alone" is only equivalent to "use the authored colour" on a
   * slot nobody has coloured yet, and every slot gets coloured eventually.
   *
   * The authored value is captured the first time the slot is seen, which is before anything here can
   * have overwritten it.
   */
  if (!AUTHORED_COLOURS.has(region)) {
    AUTHORED_COLOURS.set(region, font.color);
  }
  if (colour !== undefined) {
    font.color = toHex(colour.r, colour.g, colour.b);
  } else {
    font.color = AUTHORED_COLOURS.get(region)!;
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
/**
 * Make sure line slot `line` exists, creating it if the template did not author it.
 *
 * The real engine does this; see `AUTHORED_LINES`. What is created is a pair of `FontString`s named
 * exactly as the authored ones are (`<tooltip>TextLeft9`, `TextRight9`), so `regionOf` finds them by the
 * same name lookup and nothing else in this file needs to know which slots were authored.
 *
 * THREE THINGS ARE COPIED FROM THE AUTHORED SLOTS RATHER THAN CHOSEN:
 *
 *  - **The font.** Taken from `TextLeft1`, which inherits `GameTooltipHeaderText`/`GameTooltipText`
 *    (`gametooltiptemplate.xml:18-24`). A fresh `FontString` would otherwise get `ensureFont`'s
 *    fallback -- 12pt FRIZQT centred -- and a centred body line under left-aligned ones is visible
 *    immediately. Copied as a NEW object, not shared: `writeSide` writes `color` and `wrapWidth` per
 *    line, so a shared spec would give every grown line the last one's colour.
 *  - **The anchor.** `TOPLEFT` to the previous line's `BOTTOMLEFT` at `0,-LINE_GAP`, which is verbatim
 *    what the template does for lines 2..8 (`:36-42`).
 *  - **The layer.** `ARTWORK`, as the authored slots declare.
 *
 * Returns false when the tooltip has no authored slots at all -- an addon's bare `CreateFrame`
 * `GameTooltip` -- because there is then no font and no anchor to continue from, and inventing both is
 * how a tooltip renders plausibly and wrongly.
 */
function ensureLine(ctx: MethodContext, self: number, line: number): boolean {
  if (regionOf(ctx, self, `TextLeft${line}`) !== null) {
    return true;
  }
  const name = ctx.registry.nameOf(self);
  const first = regionOf(ctx, self, 'TextLeft1');
  const previousLeft = regionOf(ctx, self, `TextLeft${line - 1}`);
  if (name === null || first === null || previousLeft === null) {
    return false;
  }
  const leftId = ctx.registry.create('FontString', `${name}TextLeft${line}`, self);
  const left = ctx.registry.widget(leftId)!;
  left.layer = first.layer;
  left.font = { ...ensureFont(first) };
  left.shown = false;
  left.setAnchors({
    point: 'TOPLEFT', relativeTo: previousLeft.id, relativePoint: 'BOTTOMLEFT', x: 0, y: -LINE_GAP,
  });

  // The right slot is created alongside even though most lines never use one: `placeRightColumns`
  // re-anchors it every resize and `clearFrom` blanks it, and both of those look it up by name -- so a
  // grown line that later gains a right column must not be the one case where the slot is absent.
  const rightId = ctx.registry.create('FontString', `${name}TextRight${line}`, self);
  const right = ctx.registry.widget(rightId)!;
  right.layer = first.layer;
  right.font = { ...ensureFont(first) };
  right.shown = false;

  /**
   * PUBLISH BOTH TO `_G`, and this was a real defect found by driving the path rather than reading it.
   *
   * `ctx.wrapper(id)` is what mints a frame's Lua table and sets `_G[name]` (`object.ts:790-797`), and
   * it is LAZY -- nothing publishes a name until someone asks for the wrapper. Nothing here ever did, so
   * the grown slots existed in the registry and drew correctly while `_G["GameTooltipTextLeft9"]` was
   * nil. Measured live: `GameTooltip:NumLines()` answered 14 and the ninth global did not exist.
   *
   * That matters because FrameXML reaches these slots by name and not by method -- `SetTooltipMoney`
   * and `GameTooltip_AddNewbieTip` both index `_G["GameTooltipTextLeft"..i]` -- so an unpublished slot
   * is invisible to the client's own Lua and to every addon.
   */
  ctx.wrapper(leftId);
  ctx.wrapper(rightId);
  return true;
}

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
      `GameTooltip: more than ${MAX_LINES} lines -- that is this runtime's own ceiling on a grown line `
      + 'stack rather than the eight the template authors, so the extra lines are dropped',
    );
    return 0;
  }
  const line = state.lines + 1;
  // Past the authored eight, the slot has to be minted first. `ensureLine` returning false means this
  // tooltip has no authored slots to copy from at all, and `writeSide` below then answers false too.
  if (line > AUTHORED_LINES) {
    ensureLine(ctx, self, line);
  }
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
    // A NEW TOOLTIP HAS NO ITEM YET. `GameTooltip:GetItem` is about the current contents, so the
    // previous owner's item must not survive into this one -- otherwise hovering a vendor row and then
    // a micro button would still answer the sword.
    state.itemName = null;
    state.itemLink = null;
    state.anchorType = String(args[1] ?? 'ANCHOR_NONE').toUpperCase();
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

  /**
   * `GetMinimumWidth()` -- the twin of the setter below, and **`SetTooltipMoney` dies without it.**
   *
   * FOUND LIVE hovering `MerchantRepairAllButton`: the money frame had already been filled and was
   * showing the right 14 copper, and then
   * `GameTooltip.lua:135: attempt to call a nil value (method 'GetMinimumWidth')` killed the handler.
   * That line is `if ( frame:GetMinimumWidth() < moneyFrameWidth ) then frame:SetMinimumWidth(...)` --
   * the widening that stops a money row from overflowing a narrow tooltip
   * (`gametooltip.lua:133-136`). So the visible half worked and the layout correction did not, which is
   * the same shape as the `GetItem` defect two methods up: a nil inside an `OnEnter`, past the point
   * where the thing being built already looked right.
   *
   * The value is already stored -- `SetMinimumWidth` has been writing `state.minWidth` all along; only
   * the reader was missing. 0 for a tooltip that has never been given one, which is what the real
   * engine answers and what makes the comparison above take the widening branch.
   */
  GetMinimumWidth: (ctx, self) => [stateOf(widgetOf(ctx, self)).minWidth],
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

/**
 * The item-tooltip body, the twin of `fillSpellLines`.
 *
 * The NAME LINE TAKES THE ITEM'S QUALITY COLOUR, which is the one thing that makes an item tooltip
 * look like an item tooltip rather than a spell's. The colour comes from the client's own
 * `ITEM_QUALITY_COLORS`, asked of the VM as three formatted numbers -- never as a table handle, which
 * is what `SetAttribute` stored and had freed under it (see `STATE.md`). A quality the table does not
 * carry falls back to white rather than failing the whole tooltip.
 */
function fillItemLines(ctx: MethodContext, self: number, info: ItemTooltipInfo): void {
  const state = stateOf(widgetOf(ctx, self));
  state.lines = 0;
  clearFrom(ctx, self, 1);
  let colour = { r: 1, g: 1, b: 1 };
  const answer = ctx.vm.runExpr(
    `local c = ITEM_QUALITY_COLORS[${Math.floor(info.quality)}] `
    + 'if not c then return "" end return string.format("%.4f %.4f %.4f", c.r, c.g, c.b)',
    'item-tooltip-colour.lua',
  ) as { value?: unknown } | null;
  const parts = String(answer?.value ?? '').split(' ');
  if (parts.length === 3) {
    const rgb = parts.map((p) => Number(p));
    if (!rgb.some((n) => !Number.isFinite(n))) {
      colour = { r: rgb[0], g: rgb[1], b: rgb[2] };
    }
  }
  appendLine(ctx, self, info.name, null, colour, undefined, false);
  // Each line carries its own colour and, for damage/speed, a right column -- see
  // `api/items.ts#ItemTooltipInfo`. `wrap` is per line rather than always on: the flavour text and an
  // effect sentence want wrapping, and a short stat line wrapped for no reason widens the tooltip.
  for (const line of info.lines) {
    const rgb = line.colour ?? [1, 1, 1];
    appendLine(
      ctx, self, line.left, line.right ?? null,
      { r: rgb[0], g: rgb[1], b: rgb[2] }, { r: rgb[0], g: rgb[1], b: rgb[2] },
      line.wrap === true,
    );
  }
  resize(ctx, self);
  widgetOf(ctx, self).shown = true;
}

/**
 * `SetBagItem(bag, slot)` / `SetLootItem(slot)` / `SetHyperlink(link)`.
 *
 * **THIS FAMILY WAS ABSENT ON PURPOSE AND THE REASON HAS EXPIRED.** This file's header recorded it as
 * "absent, not stubbed -- each needs a feed this client has none of". The feed exists now
 * (`network/game/object/items.ts` and `.../loot.ts`), so they are real; the header's census stands, but
 * that sentence no longer describes this build.
 *
 * They SHOW THEMSELVES, exactly as `SetSpell` and `SetAction` do and for the same measured reason:
 * `ContainerFrameItemButton_OnEnter` (`containerframe.lua:774`) and `LootItem_OnEnter`
 * (`lootframe.lua:243`) both call `SetOwner` then the setter, and NEITHER calls `Show()`.
 *
 * `true`/`false` is the return contract the bag path reads to decide whether to add a "click to buy
 * back" line; false means nothing was filled and nothing is shown.
 */
const ITEM_SETTERS: MethodTable = {
  SetBagItem: (ctx, self, args) => fillFromSource(ctx, self, 'bag', Number(args[0]), Number(args[1])),
  SetLootItem: (ctx, self, args) => fillFromSource(ctx, self, 'loot', Number(args[0])),
  SetHyperlink: (ctx, self, args) => fillFromSource(ctx, self, 'link', String(args[0] ?? '')),
  /**
   * `SetInventoryItem(unit, invSlot)` -- a WORN item, identified by unit and equipment slot rather
   * than by bag and slot, so it takes the equipped read (`PLAYER_FIELD_INV_SLOT_HEAD + (id-1)*2`)
   * and not the container read.
   *
   * **Its absence was raising inside an `OnEnter`**, which is the worst place for a nil method:
   * `MainMenuBarBagButtons.lua:85` calls it when the pointer crosses a bag slot button on the main
   * bar, and the raise killed the handler part-way, leaving the tooltip chain half built.
   * `'inventory'` is the third kind the container bridge's source answers.
   */
  SetInventoryItem: (ctx, self, args) => fillFromSource(
    ctx, self, 'inventory', String(args[0] ?? 'player'), Number(args[1]),
  ),
  /**
   * `SetMerchantItem(index)` / `SetBuybackItem(index)` -- a VENDOR row and a sold-back row.
   *
   * **Both were in `TOOLTIP_SETTER_GAPS` below with the reason "no merchant window is decoded
   * (SMSG_LIST_INVENTORY has no subscriber)". It has one now** (`network/game/object/merchant.ts`),
   * so they are real and the declaration is removed rather than left describing a closed gap.
   *
   * `MerchantItemButton_OnEnter` calls `SetOwner` then one of these and never `Show()`
   * (`merchantframe.lua:434-448`), which is the same contract `SetBagItem` and `SetLootItem` answer --
   * so they show themselves through `fillFromSource`.
   */
  SetMerchantItem: (ctx, self, args) => fillFromSource(ctx, self, 'merchant', Number(args[0])),
  SetBuybackItem: (ctx, self, args) => fillFromSource(ctx, self, 'buyback', Number(args[0])),

  /**
   * `SetTrainerService(index)` -- a CLASS TRAINER's row.
   *
   * **It is not in the census below and could not have been**: that count was taken over the served
   * `FrameXML`, and this call site is in an ADDON -- `ClassTrainerSkillIcon`'s `<OnEnter>` in
   * `Interface\AddOns\Blizzard_TrainerUI\Blizzard_TrainerUI.xml:440-444`. So the census is sound for
   * what it measured and this is a reminder that the manifest is not the whole interface; the same
   * lesson `ui/framexml/addons.ts` records for `TokenFrame`.
   *
   * Unlike the bag and vendor setters this call site DOES call `Show()` itself, so filling is the whole
   * job -- `fillFromSource` showing it as well is harmless and keeps the family uniform.
   * `ui/trainer-bridge.ts` answers the `'trainer'` kind.
   */
  SetTrainerService: (ctx, self, args) => fillFromSource(ctx, self, 'trainer', Number(args[0])),

  /**
   * `GetItem()` -> `itemName, itemLink`. **A LIVE DEFECT, found on a Northshire weapon vendor.**
   *
   * `MerchantItemButton_OnEnter` calls `GameTooltip_ShowCompareItem(GameTooltip)` right after the
   * setter (`merchantframe.lua:436`), and that function opens with
   * `local item, link = self:GetItem(); if ( not link ) then return; end` (`gametooltip.lua:217-222`).
   * With this absent, every hover over a vendor row printed
   * `GameTooltip.lua:221: attempt to call a nil value (method 'GetItem')` and died INSIDE the OnEnter --
   * one line past the point where the tooltip had already been built, so the tooltip looked perfect
   * and `MerchantFrame.itemHover = button:GetID()` on the next line never ran.
   *
   * Answers whatever the last `Set<Thing>Item` filled, which is the engine's own contract: the getter
   * is about the tooltip's CURRENT CONTENTS, not about a widget.
   *
   * Both returns are honest. The link is the real hyperlink the bridges already build for
   * `GetMerchantItemLink`/`GetContainerItemLink`, so the guard above is PASSED and the comparison path
   * is entered -- see `SetHyperlinkCompareItem` and `GetAnchorType` below on why that is now safe.
   * Withholding the link to make the client take its own early return was the other option and was
   * rejected: it would have been a lie about a value this client knows.
   */
  GetItem: (ctx, self) => {
    const state = stateOf(widgetOf(ctx, self));
    return [state.itemName ?? null, state.itemLink ?? null];
  },

  /**
   * `SetHyperlinkCompareItem(link, slot, shift, owner)` -- a DECLARED GAP returning false.
   *
   * The three `shoppingTooltip`s this fills are the side-by-side comparison against what the player
   * has EQUIPPED in the same slot. That needs the equipped item for a given inventory type as well as
   * a link-to-item resolve, and nothing in this client compares two items. False is the answer
   * `GameTooltip_ShowCompareItem` already branches on (`gametooltip.lua:232-240`), and with all three
   * false every subsequent block in that function is skipped -- so the vendor tooltip draws, no
   * comparison appears, and nothing raises.
   */
  SetHyperlinkCompareItem: notImplemented(
    'GameTooltip:SetHyperlinkCompareItem',
    'the side-by-side comparison needs the equipped item for a given inventory type and a '
      + 'link-to-item resolve; nothing in this client compares two items',
    [false],
  ),

  /**
   * `GetAnchorType()` and `SetAnchorType(anchor, x, y)` -- the anchor `SetOwner` was already given.
   *
   * REAL, not stubs, and they HAD to be: `GameTooltip_ShowCompareItem` reads
   * `if ( self:GetAnchorType() and self:GetAnchorType() ~= "ANCHOR_PRESERVE" )`
   * (`gametooltip.lua:261`) unconditionally, PAST the `link` guard. So closing `GetItem` on its own
   * would have moved the identical raise forty lines down the identical function -- which is why this
   * landed as a set of three rather than as one. `SetAnchorType` is reachable in the same breath: the
   * right-hand overflow test is `rightPos + totalWidth > GetScreenWidth()`, and that is true for a
   * tooltip near the right edge even with `totalWidth` zero.
   *
   * Neither is new state. `SetOwner` already receives the anchor and already maps it through
   * `ANCHORS`; it was simply thrown away. `SetAnchorType` re-applies it with the caller's offset
   * through the SAME `ANCHORS` table and the same `setAnchors` call, so there is one anchoring rule
   * here and not two.
   */
  GetAnchorType: (ctx, self) => [stateOf(widgetOf(ctx, self)).anchorType ?? 'ANCHOR_NONE'],
  SetAnchorType: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const state = stateOf(widget);
    const anchorType = String(args[0] ?? 'ANCHOR_NONE').toUpperCase();
    state.anchorType = anchorType;
    const pair = ANCHORS[anchorType];
    const ownerWidget = state.owner === null ? null : ctx.registry.widget(state.owner);
    if (pair === undefined || ownerWidget === null) {
      // `ANCHOR_NONE`, `ANCHOR_CURSOR` and an unresolved owner all mean "the caller positions it",
      // which is what `SetOwner` does with the same three cases.
      return [];
    }
    widget.setAnchors({
      point: pair[0] as never,
      relativePoint: pair[1] as never,
      relativeTo: ownerWidget.id,
      x: Number(args[1] ?? 0),
      y: Number(args[2] ?? 0),
    });
    return [];
  },
};

/**
 * THE REST OF THE `GameTooltip:Set*` FAMILY, CENSUSED AND DECLARED RATHER THAN LEFT NIL.
 *
 * Counted across the served FrameXML rather than discovered one hover at a time -- which is how
 * `SetInventoryItem` arrived, and the point of doing this as a set. The call counts are
 * `SetOwner` 70, `SetText` 54, **`SetInventoryItem` 7**, `SetMinimumWidth` 6, then a long tail at 1-2:
 * `SetUnitAura`, `SetSpellByID`, `SetInboxItem`, `SetHyperlink`, `SetBagItem`, `SetUnit`, `SetTotem`,
 * `SetSpell`, `SetSendMailItem`, `SetQuestLogSpecialItem`, `SetPossession`, `SetPetAction`,
 * `SetMerchantItem`, `SetLootItem`, `SetLFGDungeonReward`, `SetLFGCompletionReward`,
 * `SetEquipmentSet`, `SetBuybackItem`, `SetAction`.
 *
 * **A nil method that raises inside an `OnEnter` is worse than a named gap** -- it kills the handler
 * and can leave the tooltip half built -- so every one of the tail that this client has no feed for is
 * declared here. Each returns FALSE, which is the "nothing was filled" answer its callers already
 * branch on, and the load report names it.
 *
 * Each needs a feed this client does not decode: auras, the mail box, pet actions, possession bars,
 * totems, equipment sets and the LFG reward tables. **The merchant and buyback lists were on that
 * sentence and are not any more** -- they moved up into `ITEM_SETTERS` when
 * `network/game/object/merchant.ts` landed; the census above still stands as a census.
 */
const TOOLTIP_SETTER_GAPS: Array<[string, string]> = [
  ['SetUnitAura', 'no aura feed is decoded (SMSG_AURA_UPDATE has no subscriber)'],
  ['SetSpellByID', 'the spellbook is indexed by SLOT, not by spell id -- see api/spells.ts'],
  ['SetInboxItem', 'no mail box is decoded'],
  ['SetSendMailItem', 'as SetInboxItem'],
  ['SetPetAction', 'no pet action bar is decoded (SMSG_PET_SPELLS has no subscriber)'],
  ['SetPossession', 'no possession bar exists in this client'],
  ['SetTotem', 'no totem feed is decoded'],
  ['SetEquipmentSet', 'no equipment manager is decoded'],
  ['SetQuestLogSpecialItem', 'no quest log is decoded'],
  ['SetLFGDungeonReward', 'no LFG feed is decoded'],
  ['SetLFGCompletionReward', 'as SetLFGDungeonReward'],
  ['SetUnit', 'the unit tooltip needs a hover feed the world pass does not raise'],
];
for (const [name, reason] of TOOLTIP_SETTER_GAPS) {
  ITEM_SETTERS[name] = notImplemented(`GameTooltip:${name}`, reason, [false]);
}

/**
 * Fill from whichever bridge owns this kind, and answer the TWO returns the client reads.
 *
 * `local hasCooldown, repairCost = GameTooltip:SetBagItem(bag, slot)`
 * (`containerframe.lua:774`) -- so the second return is the per-item repair cost, and
 * `ContainerFrameItemButton_OnEnter` uses it on the very next line to append `REPAIR_COST` and a
 * `SetTooltipMoney` when the player is in repair mode.
 *
 * The FIRST return keeps its existing meaning: false means nothing was filled and nothing is shown,
 * which is what every caller of this family branches on. That happens to coincide with `hasCooldown`,
 * which no call site in the manifest reads -- grepped -- so the two contracts do not collide.
 *
 * `info.repairCost` is `undefined` for every kind but a bag, and `undefined` crosses into Lua as nil,
 * which is what the real engine answers for a row that has no repair cost. See
 * `ItemTooltipInfo.repairCost` on why nil rather than 0 even though `0 > 0` would also be false.
 */
function fillFromSource(
  ctx: MethodContext,
  self: number,
  // The kind union lives in ONE place -- `api/items.ts`, where the source type is declared -- so adding
  // a kind cannot leave these two spellings of it disagreeing.
  kind: Parameters<ItemTooltipSource>[0],
  a: number | string,
  b?: number,
): unknown[] {
  const source = getItemTooltipSource(ctx.vm);
  if (source === null) {
    return [false];
  }
  const info = source(kind, a, b);
  if (info === null) {
    return [false];
  }
  fillItemLines(ctx, self, info);
  // Remembered for `GetItem`, which `GameTooltip_ShowCompareItem` reads one line after every one of
  // these setters is called.
  const state = stateOf(widgetOf(ctx, self));
  state.itemName = info.name;
  state.itemLink = info.link ?? null;
  return [true, info.repairCost ?? null];
}

Object.assign(GAMETOOLTIP, ITEM_SETTERS);

registerMethods('GAMETOOLTIP', GAMETOOLTIP);
