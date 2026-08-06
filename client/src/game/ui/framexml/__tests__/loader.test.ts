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

    vm.dispose();
  });

  it("applies an instance's own <Size> over the template's", () => {
    const { vm, rt } = runtime();

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

    vm.dispose();
  });
});
