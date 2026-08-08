import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel } from '../object';
import { WidgetRoot } from '../../../widget';
import { resolveAnchors, Viewport } from '../../../layout';
import { backdropPieces } from '../../../backdrop';
// Side-effect imports: registers the REGION/LAYEREDREGION/TEXTURE/FONTSTRING, FRAME/MODEL and
// BUTTON/CHECKBUTTON/EDITBOX method tables. Nothing here is referenced by name -- `object.ts`'s
// dispatch is the only consumer.
import '../methods/frame';
import '../methods/region';
import '../methods/kinds';

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
      parent:SetPoint("TOPLEFT")
      for _, f in ipairs({a, b, c}) do
        f:SetWidth(10)
        f:SetHeight(10)
        -- A POINT EACH, because a frame with none has no rect and is not drawn at all
        -- (layout.ts unplaceableNodes, the client's own resolver). This test is about draw ORDER,
        -- so its fixture has to be three frames that are actually on screen; before that rule
        -- existed they were placed in the window's top-left corner by default and the setup got
        -- away with saying nothing about where they are.
        f:SetPoint("TOPLEFT")
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

  it('resolves a CheckButton method from its own table, Enable from Button up the chain, and neither on a plain Frame', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    installObjectModel(vm, registry);

    const error = vm.run(
      `
      check = CreateFrame("CheckButton", "Check")
      check:SetChecked(true)
      checkHasSetChecked = check.SetChecked ~= nil
      checkHasEnable = check.Enable ~= nil
      checkIsChecked = check:GetChecked()

      plain = CreateFrame("Frame", "Plain")
      plainHasSetChecked = plain.SetChecked ~= nil
      plainHasEnable = plain.Enable ~= nil
      `,
      'checkbutton-chain.test.lua',
    );
    expect(error).toBeNull();

    // `SetChecked` is CHECKBUTTON's own -- a plain Frame must not answer to it, or the duck-typing
    // idiom `if frame.SetChecked then` would lie about every frame being a check button.
    expect(vm.getGlobal('checkHasSetChecked')).toBe(true);
    expect(vm.getGlobal('plainHasSetChecked')).toBe(false);
    // `Enable` lives on BUTTON only; CHECKBUTTON resolves it by walking up the chain, and a plain
    // Frame (no BUTTON ancestor) must not resolve it at all.
    expect(vm.getGlobal('checkHasEnable')).toBe(true);
    expect(vm.getGlobal('plainHasEnable')).toBe(false);
    expect(vm.getGlobal('checkIsChecked')).toBe(true);

    vm.dispose();
  });

  // characterselect.lua:36-38 verbatim, against `CharacterSelectCharacterFrame`'s own
  // characterselect.xml:812 backdrop. `DEFAULT_TOOLTIP_COLOR` (accountlogin.lua:2) is one flat
  // six-element table whose FIRST three are the border and whose LAST three are the background, so a
  // tint applied to the wrong half -- or to the whole widget rather than per piece -- draws a light
  // grey pane with a near-black border instead of the reverse. The alpha is the fourth argument of
  // `SetBackdropColor` alone; `SetBackdropBorderColor` is called with three, and must read 1.
  it('the two backdrop colour setters tint the background and the edges independently', () => {
    const vm = new LuaVM();
    const registry = new FrameRegistry();
    installObjectModel(vm, registry);

    const error = vm.run(
      `
      DEFAULT_TOOLTIP_COLOR = {0.8, 0.8, 0.8, 0.09, 0.09, 0.09}
      panel = CreateFrame("Frame", "Panel")
      panel:SetWidth(260)
      panel:SetHeight(642)
      panel:SetBackdrop({
        bgFile = "Interface\\\\Glues\\\\Common\\\\Glue-Tooltip-Background",
        edgeFile = "Interface\\\\Glues\\\\Common\\\\Glue-Tooltip-Border",
        tile = true, tileSize = 16, edgeSize = 16,
        insets = { left = 10, right = 5, top = 4, bottom = 9 },
      })

      local backdropColor = DEFAULT_TOOLTIP_COLOR
      panel:SetBackdropBorderColor(backdropColor[1], backdropColor[2], backdropColor[3])
      panel:SetBackdropColor(backdropColor[4], backdropColor[5], backdropColor[6], 0.85)
      `,
      'backdrop-color.test.lua',
    );
    expect(error).toBeNull();

    const widget = registry.widget(registry.byName('Panel')!)!;
    const pieces = backdropPieces({ left: 0, top: 0, width: 260, height: 642 }, widget.backdrop!);

    const background = pieces.filter((piece) => piece.sprite === 'bg');
    const edges = pieces.filter((piece) => piece.sprite === 'edge');
    expect(background).toHaveLength(1);
    expect(edges).toHaveLength(8);

    // 0.09 grey at 85% -- the dark translucent pane, not the sheet's own colour.
    expect(background[0].tint).toEqual({ r: 0.09, g: 0.09, b: 0.09, a: 0.85 });
    // All eight edge pieces, and alpha defaults to 1 for the three-argument call.
    edges.forEach((piece) => {
      expect(piece.tint).toEqual({ r: 0.8, g: 0.8, b: 0.8, a: 1 });
    });

    vm.dispose();
  });
});
