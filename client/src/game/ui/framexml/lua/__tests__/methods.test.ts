import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel } from '../object';
import { WidgetRoot } from '../../../widget';
import { resolveAnchors, Viewport } from '../../../layout';
// Side-effect imports: registers the REGION/LAYEREDREGION/TEXTURE/FONTSTRING and FRAME/MODEL method
// tables. Nothing here is referenced by name -- `object.ts`'s dispatch is the only consumer.
import '../methods/frame';
import '../methods/region';

const VIEWPORT: Viewport = { width: 1024, height: 768 };

describe('the frame and region method surface', () => {
  it('SetPoint through Lua resolves to the same rect the TypeScript anchor path computes', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    installObjectModel(vm, registry);

    const error = vm.run(
      `
      parent = CreateFrame("Frame", "Parent")
      parent:SetWidth(200)
      parent:SetHeight(100)
      parent:SetPoint("TOPLEFT", 10, -20)

      -- The (point, relativeTo, relativePoint, x, y) form, anchored to another frame's TABLE (not
      -- its name) -- the other shape 'SetPoint's relativeTo argument takes in real FrameXML.
      child = CreateFrame("Frame", "Child", parent)
      child:SetWidth(50)
      child:SetHeight(50)
      child:SetPoint("TOPLEFT", parent, "BOTTOMRIGHT", 5, -5)

      -- The explicit-nil-relativeTo form -- "anchor to the screen at an offset", the common FrameXML
      -- idiom this project's own regression (samples/benilla's anchors.rs) exists for. The bug this
      -- guards: a nil that fails to consume its argument slot shifts relativePoint/x/y left and
      -- silently drops the real offset.
      nilAnchored = CreateFrame("Frame", "NilAnchored")
      nilAnchored:SetWidth(300)
      nilAnchored:SetHeight(200)
      nilAnchored:SetPoint("TOPLEFT", nil, "TOPLEFT", 40, -40)
      `,
      'setpoint.test.lua',
    );
    expect(error).toBeNull();

    const parentWidget = registry.widget(registry.byName('Parent')!)!;
    const childWidget = registry.widget(registry.byName('Child')!)!;
    const nilAnchoredWidget = registry.widget(registry.byName('NilAnchored')!)!;

    const rectsFromLua = resolveAnchors(
      [parentWidget, childWidget, nilAnchoredWidget].map((widget) => ({
        id: widget.id,
        width: widget.width,
        height: widget.height,
        anchors: widget.anchors,
      })),
      VIEWPORT,
    );

    // The same three anchors, hand-built directly against `layout.ts` -- the oracle `SetPoint`'s
    // output has to agree with, not just "some rect".
    const rectsFromTs = resolveAnchors(
      [
        { id: 'p', width: 200, height: 100, anchors: [{ point: 'TOPLEFT', x: 10, y: -20 }] },
        {
          id: 'c',
          width: 50,
          height: 50,
          anchors: [{ point: 'TOPLEFT', relativeTo: 'p', relativePoint: 'BOTTOMRIGHT', x: 5, y: -5 }],
        },
        {
          id: 'n',
          width: 300,
          height: 200,
          // No `relativeTo` at all -- an explicit nil resolves to "the screen" here exactly as it
          // does for the Lua call, since `NilAnchored` has no parent frame either.
          anchors: [{ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 40, y: -40 }],
        },
      ],
      VIEWPORT,
    );

    expect(rectsFromLua.get(parentWidget.id)).toEqual(rectsFromTs.get('p'));
    expect(rectsFromLua.get(childWidget.id)).toEqual(rectsFromTs.get('c'));
    expect(rectsFromLua.get(nilAnchoredWidget.id)).toEqual(rectsFromTs.get('n'));
    // The regression's most direct form: a dropped offset would leave this at (0, 0) instead.
    expect(rectsFromLua.get(nilAnchoredWidget.id)).toEqual({ left: 40, top: 40, width: 300, height: 200 });

    vm.dispose();
  });

  it('SetFrameLevel to the same value leaves draw order untouched; a changed value re-stamps to the front', () => {
    const widgetRoot = new WidgetRoot();
    const registry = new FrameRegistry(widgetRoot.root);
    const vm = new LuaVM();
    installObjectModel(vm, registry);

    const error = vm.run(
      `
      parent = CreateFrame("Frame", "Parent")
      a = CreateFrame("Frame", "A", parent)
      b = CreateFrame("Frame", "B", parent)
      c = CreateFrame("Frame", "C", parent)
      for _, f in ipairs({a, b, c}) do
        f:SetWidth(10)
        f:SetHeight(10)
      end
      `,
      'level-setup.test.lua',
    );
    expect(error).toBeNull();

    const idOf = (name: string) => registry.widget(registry.byName(name)!)!.id;
    const orderOf = () => widgetRoot.drawList(VIEWPORT).map((item) => item.widget.id);

    // Declared A, B, C, all children of the same parent -- same strata and level -- so that is the
    // draw order: A behind B behind C.
    const before = orderOf();
    expect(before.indexOf(idOf('A'))).toBeLessThan(before.indexOf(idOf('B')));
    expect(before.indexOf(idOf('B'))).toBeLessThan(before.indexOf(idOf('C')));

    // THE RULE: setting B's level to what it already is must NOT move it. A buggy re-stamp would
    // jump B to the front of the bucket (above C), which is exactly what this catches.
    const sameValueError = vm.run('b:SetFrameLevel(b:GetFrameLevel())', 'same-level.test.lua');
    expect(sameValueError).toBeNull();
    expect(orderOf()).toEqual(before);

    // A CHANGED value does re-stamp: leaving A's bucket and coming back to it (two real changes)
    // moves A to the front -- above both B and C, despite A having been declared first.
    const changedValueError = vm.run(
      `
      local level = a:GetFrameLevel()
      a:SetFrameLevel(level + 1)
      a:SetFrameLevel(level)
      `,
      'changed-level.test.lua',
    );
    expect(changedValueError).toBeNull();

    const after = orderOf();
    expect(after.indexOf(idOf('A'))).toBeGreaterThan(after.indexOf(idOf('B')));
    expect(after.indexOf(idOf('A'))).toBeGreaterThan(after.indexOf(idOf('C')));

    vm.dispose();
  });
});
