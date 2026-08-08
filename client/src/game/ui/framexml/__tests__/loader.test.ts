import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { WidgetRoot } from '../../widget';
import { Viewport } from '../../layout';

const VIEWPORT: Viewport = { width: 1024, height: 768 };

/** A runtime over a fresh VM and widget tree. The root is handed back so rects can be resolved. */
function runtime() {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry);
  return { vm, root, registry, rt: createFrameXmlRuntime(vm, ctx) };
}

/** No file resolver: both documents are inline, which is the point of the injected seam. */
const noFiles = () => null;

describe('loadDocument', () => {
  it('materializes a whole document: template, $parent, regions, nested frames, bottom-up OnLoad', () => {
    const { vm, root, registry, rt } = runtime();

    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Script>
            order = {}
          </Script>

          <Frame name="PanelTemplate" virtual="true">
            <Size><AbsDimension x="80" y="22"/></Size>
          </Frame>

          <Frame name="Login">
            <Size><AbsDimension x="400" y="300"/></Size>
            <Anchors>
              <Anchor point="TOPLEFT"><Offset><AbsDimension x="40" y="-40"/></Offset></Anchor>
            </Anchors>
            <Layers>
              <Layer level="BACKGROUND">
                <Texture name="$parentBackground" file="Interface\\Glues\\Common\\Glue-Tooltip-Background">
                  <Size><AbsDimension x="256" y="256"/></Size>
                  <Anchors>
                    <Anchor point="TOPLEFT"><Offset><AbsDimension x="8" y="-6"/></Offset></Anchor>
                  </Anchors>
                </Texture>
              </Layer>
            </Layers>
            <Frames>
              <Frame name="$parentPanel" inherits="PanelTemplate">
                <Anchors>
                  <Anchor point="TOPLEFT" relativeTo="$parent" relativePoint="TOPLEFT">
                    <Offset><AbsDimension x="10" y="-10"/></Offset>
                  </Anchor>
                </Anchors>
                <Scripts>
                  <OnLoad>table.insert(order, this:GetName())</OnLoad>
                </Scripts>
              </Frame>
            </Frames>
            <Scripts>
              <OnLoad>
                table.insert(order, self:GetName())
                childWidthWhenParentLoaded = LoginPanel:GetWidth()
              </OnLoad>
            </Scripts>
          </Frame>
        </Ui>
      `),
      noFiles,
      'AccountLogin.xml',
    );

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    // Two FRAMES: the root and its nested child. The texture is a region, created through its owner,
    // not through CreateFrame.
    expect(report.frames).toBe(2);

    // `$parent` resolved against the enclosing frame's name, for both a nested frame and a region.
    expect(registry.byName('LoginPanel')).not.toBeNull();
    expect(registry.byName('LoginBackground')).not.toBeNull();

    // Bottom-up: the child's OnLoad ran first, and by the time the parent's ran the child was fully
    // built -- template size included, which is what the parent reads here. Both calling conventions
    // are exercised in the same pair: the child's handler reads the legacy `this` global, the parent's
    // reads the modern `self` argument.
    expect(vm.getGlobal('childWidthWhenParentLoaded')).toBe(80);
    const order = vm.runExpr('return table.concat(order, ",")', 'order.lua');
    expect(order).toEqual({ value: 'LoginPanel,Login' });

    // One exact rect, through the real layout path: Login sits at (40, 40) on the 1024x768 screen
    // (FrameXML's +y is up, so the -40 offset moves DOWN), and its background texture hangs 8 right and
    // 6 down from that corner at its own authored 256x256.
    const textureId = registry.widget(registry.byName('LoginBackground')!)!.id;
    const rect = root.drawList(VIEWPORT).find((item) => item.widget.id === textureId)!.rect;
    expect(rect).toEqual({ left: 48, top: 46, width: 256, height: 256 });

    // `reset()` BEFORE `dispose()`, the same order `GlueRuntime#dispose` uses -- and it is not
    // ceremony here: `kinds.ts`'s per-button side tables are module-level while frame ids restart at 1
    // per registry, so a test that leaves them populated hands the NEXT test's button a stale label
    // id -- a documented hazard of those tables, and this is the first file with two tests that both
    // build a Button. Every test in this file resets for that reason.
    registry.reset();
    vm.dispose();
  });

  it("applies an instance's own <Size> over the template's", () => {
    const { vm, registry, rt } = runtime();

    // Two things at once, and only because they are the same call: the instance's 125x21 must beat the
    // template's 80x22 (the merge appends the instance's children LAST, so a first-match read would
    // report 80x22 here), and the instance must MATERIALIZE at all -- expansion splices the template's
    // `virtual="true"` onto it, so classifying after expansion would file it away as a template and
    // build nothing.
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Button name="GlueButtonTemplate" virtual="true">
            <Size><AbsDimension x="80" y="22"/></Size>
          </Button>
          <Button name="LoginButton" inherits="GlueButtonTemplate">
            <Size><AbsDimension x="125" y="21"/></Size>
          </Button>
        </Ui>
      `),
      noFiles,
      'GlueButtons.xml',
    );

    expect(report.errors).toEqual([]);
    expect(report.frames).toBe(1);
    expect(vm.runExpr('return LoginButton:GetWidth()', 'w.lua')).toEqual({ value: 125 });
    expect(vm.runExpr('return LoginButton:GetHeight()', 'h.lua')).toEqual({ value: 21 });

    // `reset()` before `dispose()`, as `GlueRuntime#dispose` does -- see the note on the first test.
    registry.reset();
    vm.dispose();
  });

  it("gives a frame created FROM LUA with a template the template's children", () => {
    const { vm, registry, rt } = runtime();

    // `GlueDropDownMenuButtonTemplate` cut to its shape (gluedropdownmenutemplates.xml:3): a `<Layers>`
    // texture and a nested `<Frames>` button, both named with `$parent`. The client creates these
    // buttons only from Lua -- `CreateFrame("BUTTON", listName.."Button"..i, list, template)`,
    // GlueDropDownMenu.lua:159 -- and then reads the children back by GLOBAL on the very next lines.
    // With the 4th argument dropped they did not exist, and `_G[...InvisibleButton]:Hide()` was two of
    // the manifest's load errors.
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Button name="MenuButtonTemplate" virtual="true">
            <Size><AbsDimension x="128" y="16"/></Size>
            <Layers>
              <Layer level="ARTWORK">
                <Texture name="$parentCheck" file="Interface\\Buttons\\UI-CheckBox-Check"/>
              </Layer>
            </Layers>
            <Frames>
              <Button name="$parentInvisibleButton" hidden="true"/>
            </Frames>
          </Button>
          <Frame name="DropDownList1"><Anchors><Anchor point="TOPLEFT"/></Anchors></Frame>
        </Ui>
      `),
      noFiles,
      'GlueDropDownMenuTemplates.xml',
    );
    expect(report.errors).toEqual([]);

    const error = vm.run(
      'CreateFrame("BUTTON", "DropDownList1Button1", DropDownList1, "MenuButtonTemplate")\n' +
        'checkName = DropDownList1Button1Check:GetName()\n' +
        'invisibleShown = DropDownList1Button1InvisibleButton:IsShown()\n' +
        'width = DropDownList1Button1:GetWidth()',
      'gluedropdownmenu.lua',
    );

    expect(error).toBeNull();
    // The two children, addressable by the `$parent`-resolved globals the client's own Lua reads.
    expect(vm.getGlobal('checkName')).toBe('DropDownList1Button1Check');
    expect(registry.byName('DropDownList1Button1InvisibleButton')).not.toBeNull();
    // The child's own attributes came with it, not just its existence...
    expect(vm.getGlobal('invisibleShown')).toBe(false);
    // ...and so did the template's `<Size>`, through the same pass an XML instance uses.
    expect(vm.getGlobal('width')).toBe(128);

    // `reset()` before `dispose()`, as `GlueRuntime#dispose` does -- see the note on the first test.
    registry.reset();
    vm.dispose();
  });

  it("gives a <ButtonText>'s declared name to the REGISTRY too, so SetPoint can anchor to it", () => {
    const { vm, root, registry, rt } = runtime();

    // The shape from `realmlist.xml:179-252`, cut to the two elements that matter: a button whose label
    // is a named `<ButtonText>`, and a sibling font string that anchors itself to that label BY NAME.
    // The label is created by `SetText`'s lazy constructor, which takes no name, so both name spaces
    // have to be filled -- `_G` for `_G[...]` lookups and the FrameRegistry for `SetPoint`'s
    // `relativeTo` string. Filling only `_G` left the client anchoring to the 512-wide BUTTON instead,
    // which put every realm row's type, character-count and population columns off the panel.
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Button name="RealmRow">
            <Size><AbsDimension x="512" y="16"/></Size>
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
            <Layers>
              <Layer level="BACKGROUND">
                <FontString name="$parentPVP">
                  <Size><AbsDimension x="60" y="12"/></Size>
                  <Anchors><Anchor point="LEFT"/></Anchors>
                </FontString>
              </Layer>
            </Layers>
            <Scripts>
              <OnLoad>
                _G[self:GetName().."PVP"]:SetPoint("LEFT", self:GetName().."NormalText", "RIGHT", 10, 0);
              </OnLoad>
            </Scripts>
            <ButtonText name="$parentNormalText">
              <Size><AbsDimension x="220" y="12"/></Size>
              <Anchors><Anchor point="LEFT"><Offset><AbsDimension x="5" y="0"/></Offset></Anchor></Anchors>
            </ButtonText>
          </Button>
        </Ui>
      `),
      noFiles,
      'RealmList.xml',
    );

    expect(report.errors).toEqual([]);
    // Both name spaces: the registry (what `SetPoint`'s name string resolves through) and `_G`.
    expect(registry.byName('RealmRowNormalText')).not.toBeNull();
    expect(vm.runExpr('return RealmRowNormalText:GetName()', 'n.lua')).toEqual({
      value: 'RealmRowNormalText',
    });

    // And the anchor landed on the LABEL, not on the button: the label is 220 wide at the button's
    // LEFT +5, so its RIGHT edge is 225 in and the type column starts 10 further at 235. Anchored to
    // the button instead, it would have started at the button's own right edge, 512.
    const pvpId = registry.widget(registry.byName('RealmRowPVP')!)!.id;
    const rect = root.drawList(VIEWPORT).find((item) => item.widget.id === pvpId)!.rect;
    expect(rect.left).toBe(235);

    // `reset()` before `dispose()`, as `GlueRuntime#dispose` does -- see the note on the first test.
    registry.reset();
    vm.dispose();
  });

  it('resolves a <Font> chain: face from the root, colour from the middle, height from the leaf', () => {
    const { vm, registry, rt } = runtime();

    // The shape of `gluefontstyles.xml`'s real chains, one level per channel so a wrong merge shows up
    // as a wrong CHANNEL rather than a wrong font. The root carries the face and a height, the middle
    // recolours, the leaf overrides the height and left-justifies -- exactly
    // `SystemFont_Outline_Med2 -> GlueFontNormal -> GlueFontNormalLeft` with the height moved to the
    // leaf so the "last <FontHeight> wins" rule is under test too (reading the FIRST would give 15).
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Font name="RootFont" font="Fonts\\FRIZQT__.TTF" outline="NORMAL" virtual="true">
            <FontHeight><AbsValue val="15"/></FontHeight>
          </Font>
          <Font name="MiddleFont" inherits="RootFont" virtual="true">
            <Color r="0.1" g="1.0" b="0.1"/>
          </Font>
          <Font name="LeafFont" inherits="MiddleFont" justifyH="LEFT" virtual="true">
            <FontHeight><AbsValue val="10"/></FontHeight>
          </Font>

          <Frame name="Panel">
            <Size><AbsDimension x="200" y="40"/></Size>
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
            <Layers>
              <Layer level="ARTWORK">
                <FontString name="$parentLabel" inherits="LeafFont" text="Медив"/>
              </Layer>
            </Layers>
          </Frame>
        </Ui>
      `),
      noFiles,
      'GlueFontStyles.xml',
    );

    expect(report.errors).toEqual([]);
    expect(registry.widget(registry.byName('PanelLabel')!)!.font).toEqual({
      family: 'FRIZQT',
      // From the LEAF, not the root: 10, not 15.
      size: 10,
      // From the MIDDLE: 0.1/1.0/0.1 green.
      color: '#1aff1a',
      // From the ROOT -- and TRUE, which is the whole point of `fonts.ts#isOutlined`: the XML says
      // `outline="NORMAL"`, and handing that string to `SetFont`'s `OUTLINE`-substring test read false.
      outline: true,
      align: 'LEFT',
    });

    // `reset()` before `dispose()`, as `GlueRuntime#dispose` does -- see the note on the first test.
    registry.reset();
    vm.dispose();
  });

  it("colours a realm row's name from Lua, through the font object the <Font> published as a global", () => {
    const { vm, registry, rt } = runtime();

    // `realmlist.lua:123` verbatim in shape: `button:SetNormalFontObject(RealmCharactersNormal)` -- a
    // BARE GLOBAL, which only exists because a `<Font name=>` publishes one. The button's own
    // `<NormalFont style="GlueFontNormalLeft"/>` is the gold it starts at, so this asserts the switch,
    // not the default: gold before the call, green after it.
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Font name="GlueFontNormalLeft" font="Fonts\\FRIZQT__.TTF" outline="NORMAL" justifyH="LEFT" virtual="true">
            <FontHeight><AbsValue val="15"/></FontHeight>
            <Color r="1.0" g="0.78" b="0"/>
          </Font>
          <Font name="RealmCharactersNormal" inherits="GlueFontNormalLeft" virtual="true">
            <Color r="0.1" g="1.0" b="0.1"/>
          </Font>

          <Button name="RealmRow">
            <Size><AbsDimension x="512" y="16"/></Size>
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
            <ButtonText name="$parentNormalText">
              <Size><AbsDimension x="220" y="12"/></Size>
              <Anchors><Anchor point="LEFT"/></Anchors>
            </ButtonText>
            <NormalFont style="GlueFontNormalLeft"/>
          </Button>
        </Ui>
      `),
      noFiles,
      'RealmList.xml',
    );

    expect(report.errors).toEqual([]);
    const label = registry.widget(registry.byName('RealmRowNormalText')!)!;
    expect(label.font!.color).toBe('#ffc700');

    expect(vm.run('RealmRow:SetText("Медив (x1)"); RealmRow:SetNormalFontObject(RealmCharactersNormal)', 'r.lua')).toBeNull();
    expect(label.font!.color).toBe('#1aff1a');
    // The rest of the chain came with it, rather than being reset by a partial write.
    expect(label.font!.size).toBe(15);
    expect(label.font!.align).toBe('LEFT');

    // `reset()` before `dispose()`, as `GlueRuntime#dispose` does -- see the note on the first test.
    registry.reset();
    vm.dispose();
  });
});

describe('the parent= attribute', () => {
  it('builds a top-level frame under the frame it names, so the owner\'s Hide() reaches it', () => {
    const { vm, root, registry, rt } = runtime();

    // The shape `paperdollframe.xml:229` has: an OWNER declared `hidden="true"`
    // (`characterframe.xml:4`) and a separate top-level frame claiming it as its parent. Before
    // `parent=` was honoured the second was built at the document root, so it drew over the world
    // although nobody had opened the character sheet.
    const report = loadDocument(
      rt,
      parseXml(`
        <Ui>
          <Frame name="CharacterFrame" hidden="true">
            <Size><AbsDimension x="384" y="512"/></Size>
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
          </Frame>
          <Frame name="PaperDollFrame" setAllPoints="true" parent="CharacterFrame"/>
        </Ui>
      `),
      noFiles,
      'CharacterFrame.xml',
    );

    expect(report.errors).toEqual([]);
    const owner = registry.widget(registry.byName('CharacterFrame')!)!;
    const child = registry.widget(registry.byName('PaperDollFrame')!)!;
    expect(child.parent).toBe(owner);
    // `visible` walks the shown chain, which is what the draw list uses.
    expect(child.visible).toBe(false);
    // ...and `setAllPoints` now pins it to the owner's rect rather than the whole screen.
    expect(root.drawList(VIEWPORT).some((item) => item.widget === child)).toBe(false);

    registry.reset();
    vm.dispose();
  });
});
