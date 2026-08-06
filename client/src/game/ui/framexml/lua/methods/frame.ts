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
import { MethodTable, onFrameTeardown, registerMethods } from '../object';
import type { Insets } from '../../../backdrop';
import { Layer } from '../../../widget';
import { STRATA_ORDER, Strata } from '../../order';
import { isDrawLayer, notImplemented, warnOnce, widgetOf } from './region';

/**
 * `Frame:GetID()`/`SetID()` -- an arbitrary numeric tag (list-row index, action-button slot, ...),
 * unrelated to the widget's own string `id` that `layout.ts` anchors against. Kept in a side table
 * rather than on `Widget` itself: it is a pure Lua-surface concept with no rendering or layout
 * meaning, unlike everything else `Widget` carries.
 */
const frameIds = new Map<number, number>();

/** A released frame takes its numeric tag with it -- see `object.ts`'s `FRAME_TEARDOWN`. */
onFrameTeardown((_ctx, id) => {
  frameIds.delete(id);
});

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

  // Real `Region` has NO scale method at all in the 3.3.5 API -- scale is Frame-only, because it
  // cascades to a frame's CHILDREN, and a leaf Texture/FontString has none to cascade to. Registering
  // these on REGION (as an earlier pass here did) would make `if texture.SetScale then` true, which
  // is exactly the duck-typing leak this task exists to close. Nothing in `widget.ts` models a
  // per-widget scale that cascades the way `frameLevel` does at `Widget#add`, so this is still a
  // warn-once no-op -- just on the right class now.
  SetScale: notImplemented('SetScale', 'widget.ts has no per-widget scale field yet'),
  GetEffectiveScale: notImplemented('GetEffectiveScale', 'reporting the only scale that exists today (1)', [1]),

  EnableMouse: (ctx, self, args) => {
    widgetOf(ctx, self).mouseEnabled = Boolean(args[0]);
    return [];
  },

  /**
   * SetBackdrop(table) -- the tiled background plus the eight-piece border, as
   * `frame:SetBackdrop{ bgFile=, edgeFile=, tile=, edgeSize=, tileSize=, insets={...} }`.
   *
   * This was a warn-once no-op on the grounds that `MethodContext` cannot reach a `GlueArt` table to
   * turn a path into a sprite key. That reasoning had a hole: nothing says a sprite key may not BE the
   * path. `BackdropDef` holds keys, and a caller that registers each path under itself
   * (`framexml/runtime.ts`, which walks the finished tree and registers what it finds) makes the two
   * the same string -- so no art handle is needed here at all, only honest storage. Without this, every
   * `<Backdrop>` in the client's own XML drew nothing: both login edit boxes lost their border, and the
   * loader's `<Backdrop>` pass, which builds the table correctly, had nowhere to put it.
   *
   * The frame moves to BACKGROUND, because that is where the engine draws a Backdrop: BENEATH every
   * layer of its own frame, including the frame's own BACKGROUND font strings. Our layer ladder is
   * flat, so sitting on BACKGROUND ahead of them in insertion order is how that is expressed -- the
   * same thing `screens/login.ts` does by hand for the transcribed boxes, and what keeps an edit box's
   * placeholder visible on top of its border instead of behind it.
   */
  SetBackdrop: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const table = args[0];
    if (table === undefined || table === null) {
      widget.backdrop = null;
      return [];
    }
    if (!ctx.vm.isRef(table)) {
      throw new Error('SetBackdrop: the backdrop must be a table or nil');
    }
    const str = (key: string): string | null => {
      const value = ctx.vm.getTableField(table, key);
      return typeof value === 'string' && value !== '' ? value : null;
    };
    const numberField = (key: string, fallback: number): number => {
      const value = ctx.vm.getTableField(table, key);
      return typeof value === 'number' ? value : fallback;
    };

    // `insets` is a nested table, so reading it mints a handle this call owns and has to give back.
    const insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
    const insetsField = ctx.vm.getTableField(table, 'insets');
    if (ctx.vm.isRef(insetsField)) {
      try {
        for (const side of ['left', 'right', 'top', 'bottom'] as const) {
          const value = ctx.vm.getTableField(insetsField, side);
          if (typeof value === 'number') {
            insets[side] = value;
          }
        }
      } finally {
        ctx.vm.unref(insetsField);
      }
    }

    widget.backdrop = {
      bgSprite: str('bgFile'),
      edgeSprite: str('edgeFile'),
      edgeSize: numberField('edgeSize', 0),
      tileSize: numberField('tileSize', 0),
      backgroundInsets: insets,
    };
    widget.layer = 'BACKGROUND';
    return [];
  },
  SetBackdropColor: notImplemented('SetBackdropColor', 'BackdropDef has no tint field yet'),
  SetBackdropBorderColor: notImplemented('SetBackdropBorderColor', 'BackdropDef has no tint field yet'),

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
  SetModel: notImplemented('SetModel', 'no per-widget model state exists; see MODEL surface note'),
  SetCamera: notImplemented('SetCamera', 'no per-widget model state exists; see MODEL surface note'),
  SetSequence: notImplemented('SetSequence', 'no per-widget model state exists; see MODEL surface note'),
  SetFogNear: notImplemented('SetFogNear', 'no per-widget model state exists; see MODEL surface note'),
  SetFogFar: notImplemented('SetFogFar', 'no per-widget model state exists; see MODEL surface note'),
  SetFogColor: notImplemented('SetFogColor', 'no per-widget model state exists; see MODEL surface note'),
  ClearFog: notImplemented('ClearFog', 'no per-widget model state exists; see MODEL surface note'),
  SetGlow: notImplemented('SetGlow', 'no per-widget model state exists; see MODEL surface note'),
};

registerMethods('FRAME', FRAME);
registerMethods('MODEL', MODEL);
