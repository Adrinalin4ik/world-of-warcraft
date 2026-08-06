/**
 * FRAME and MODEL: the methods a plain frame answers to that a bare Region/LayeredRegion does not --
 * frame strata and level, mouse input, backdrops, and the two child-region constructors -- plus the
 * model-frame stubs.
 *
 * `SetScript`/`GetScript` and `RegisterEvent`/`UnregisterEvent` are in the plan's Frame list but are
 * deliberately NOT here: `object.ts`'s own docstring assigns `SetScript` to Task 5, and the plan
 * gives `RegisterEvent`/`UnregisterEvent` their own task (Task 6, `lua/events.ts`) with real ordering
 * rules ("re-registering keeps the original position", "dispatch re-reads the live list") that a
 * stub here would either fake or collide with. Registering a placeholder now that Task 5/6 overwrite
 * is harmless (`registerMethods` merges), but a placeholder that does nothing observable is also not
 * worth the confusion of two tasks touching the same name for different reasons.
 */
import { MethodTable, registerMethods } from '../object';
import { Layer } from '../../../widget';
import { STRATA_ORDER, Strata } from '../../order';
import { isDrawLayer, warnOnce, widgetOf } from './region';

/**
 * `Frame:GetID()`/`SetID()` -- an arbitrary numeric tag (list-row index, action-button slot, ...),
 * unrelated to the widget's own string `id` that `layout.ts` anchors against. Kept in a side table
 * rather than on `Widget` itself: it is a pure Lua-surface concept with no rendering or layout
 * meaning, unlike everything else `Widget` carries.
 */
const frameIds = new Map<number, number>();

const FRAME: MethodTable = {
  GetID: (_ctx, self) => [frameIds.get(self) ?? 0],
  SetID: (_ctx, self, args) => {
    frameIds.set(self, Number(args[0] ?? 0));
    return [];
  },

  SetFrameStrata: (ctx, self, args) => {
    const value = String(args[0] ?? '').toUpperCase();
    if (!STRATA_ORDER.includes(value as Strata)) {
      warnOnce(`SetFrameStrata: unknown strata '${value}'`);
      return [];
    }
    const widget = widgetOf(ctx, self);
    // Same-value guard for the same reason `SetFrameLevel` below has one: `restamp()` moves a frame
    // to its bucket's tail, and a no-op set re-stamping it would jump it to the front of its strata
    // for no reason.
    if (widget.strata === value) {
      return [];
    }
    widget.strata = value as Strata;
    widget.restamp();
    return [];
  },
  GetFrameStrata: (ctx, self) => [widgetOf(ctx, self).strata],

  // THE rule this file exists to get right: a same-value `SetFrameLevel` must early-out before
  // touching `restamp()`. Re-stamping on a no-op set is what makes a frame jump to the front of its
  // draw bucket for no reason -- nothing about "set my level to what it already is" should move
  // anything.
  SetFrameLevel: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const level = Number(args[0] ?? 0);
    if (widget.frameLevel === level) {
      return [];
    }
    widget.frameLevel = level;
    widget.restamp();
    return [];
  },
  GetFrameLevel: (ctx, self) => [widgetOf(ctx, self).frameLevel],

  EnableMouse: (ctx, self, args) => {
    widgetOf(ctx, self).mouseEnabled = Boolean(args[0]);
    return [];
  },

  // A `Backdrop` needs art resolved through `GlueArt` (path -> sprite KEY, then an async fetch) --
  // see `art.ts` and `widget.ts`'s note that `BackdropDef` holds sprite keys, never paths. Nothing in
  // `MethodContext` reaches a `GlueArt` table, and `BackdropDef` has no tint field for the Color
  // variant either. XML-authored backdrops go through a different path (the loader, Task 7) that
  // already has that art table in hand; a live Lua call to change one at runtime is out of reach
  // until `MethodContext` grows an art handle.
  SetBackdrop: () => {
    warnOnce('SetBackdrop: not implemented -- MethodContext has no GlueArt handle to resolve art through');
    return [];
  },
  SetBackdropColor: () => {
    warnOnce('SetBackdropColor: not implemented -- BackdropDef has no tint field yet');
    return [];
  },
  SetBackdropBorderColor: () => {
    warnOnce('SetBackdropBorderColor: not implemented -- BackdropDef has no tint field yet');
    return [];
  },

  // `registry.create` is the sanctioned path for a region owned by a frame -- `object.ts`'s own
  // comment on `CREATE_FRAME_CLASSES` is explicit that a Texture is created through its OWNER, not
  // through `CreateFrame`, and `create()` itself (unlike the `CreateFrame` Lua function) never
  // checked that list.
  CreateTexture: (ctx, self, args) => {
    const name = typeof args[0] === 'string' ? args[0] : null;
    const id = ctx.registry.create('Texture', name, self);
    applyLayer(ctx.registry.widget(id)!, args[1]);
    return [ctx.wrapper(id)];
  },
  CreateFontString: (ctx, self, args) => {
    const name = typeof args[0] === 'string' ? args[0] : null;
    const id = ctx.registry.create('FontString', name, self);
    applyLayer(ctx.registry.widget(id)!, args[1]);
    return [ctx.wrapper(id)];
  },

  // Our draw order has one live-list axis (`linkStamp`) rather than the client's separate "raised"
  // flag; moving to the tail of the bucket is the same visible effect `Raise()` has -- above every
  // sibling at the same strata and level that has not itself been raised or shown since.
  Raise: (ctx, self) => {
    widgetOf(ctx, self).restamp();
    return [];
  },
};

function applyLayer(widget: { layer: Layer }, arg: unknown): void {
  if (typeof arg !== 'string') {
    return;
  }
  const layer = arg.toUpperCase();
  if (isDrawLayer(layer)) {
    widget.layer = layer;
  } else {
    warnOnce(`CreateTexture/CreateFontString: unknown layer '${layer}'`);
  }
}

/**
 * The model-frame surface: `MODEL`/`ModelFFX`/`PlayerModel` all resolve here (`object.ts`'s class
 * aliases). None of these are wired to anything -- the glue's 3D stage (`scene/glue-scene.ts`) is a
 * single `GlueSceneView` singleton driven by SCENE TOKENS from `screens.ts`, not by per-widget state
 * a `MODEL` frame's own Lua calls could reach. Wiring these for real needs two things neither exists
 * today: a per-widget model-state field on `Widget` (file, sequence, camera index, fog triple, glow),
 * and a bridge from that state to `GlueSceneView` (or a second, Lua-driven scene instance). Until
 * then these resolve non-nil and do nothing, which is right: `if frame.SetSequence then` must see a
 * Model as a Model, and a method that silently loaded a WRONG model would be worse than one that
 * visibly does nothing.
 */
const MODEL: MethodTable = {
  SetModel: () => {
    warnOnce('SetModel: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
  SetCamera: () => {
    warnOnce('SetCamera: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
  SetSequence: () => {
    warnOnce('SetSequence: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
  SetFogNear: () => {
    warnOnce('SetFogNear: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
  SetFogFar: () => {
    warnOnce('SetFogFar: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
  SetFogColor: () => {
    warnOnce('SetFogColor: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
  ClearFog: () => {
    warnOnce('ClearFog: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
  SetGlow: () => {
    warnOnce('SetGlow: not implemented -- no per-widget model state exists; see MODEL surface note');
    return [];
  },
};

registerMethods('FRAME', FRAME);
registerMethods('MODEL', MODEL);
