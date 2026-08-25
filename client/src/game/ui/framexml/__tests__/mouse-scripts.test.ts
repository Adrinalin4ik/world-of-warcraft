/**
 * A frame that DECLARES a mouse script is mouse-interactive.
 *
 * Measured, and it is one cause behind three of the owner's reports at once -- no tooltip on a
 * character-panel stat, none on a resistance icon, none on the experience bar -- while ITEM tooltips
 * worked. `StatFrameTemplate` (`paperdollframe.xml:170,202-209`), `MagicResistanceFrameTemplate`
 * (`:211,215-224`) and `MainMenuExpBar` (`mainmenubar.xml:12`) are a Frame, a Frame and a StatusBar;
 * every one declares `<OnEnter>` and NOT ONE declares `enableMouse`, whose `UI.xsd:470` default is
 * `false`. `hitTest` only answers a `mouseEnabled` widget, so their handlers were dead code.
 *
 * One test on the rule, one on the limit that keeps it from arming the whole manifest.
 */
import { LuaVM } from '../lua/vm';
import { FrameRegistry, installObjectModel } from '../lua/object';
import { createFrameXmlRuntime, loadDocument } from '../loader';
import { parseXml } from '../xml';
import { Widget, WidgetRoot } from '../../widget';

function load(xml: string) {
  const vm = new LuaVM();
  const root = new WidgetRoot();
  const registry = new FrameRegistry(root.root);
  const ctx = installObjectModel(vm, registry, null);
  const rt = createFrameXmlRuntime(vm, ctx);
  const report = loadDocument(rt, parseXml(xml), () => null, 'inline.xml');
  return {
    report,
    widget: (name: string) => registry.widget(registry.byName(name)!) as Widget,
  };
}

describe('declaring a mouse script arms the frame', () => {
  it('enables the mouse on a <Frame> and a <StatusBar> that only declare <OnEnter>', () => {
    const { report, widget } = load(`
      <Ui>
        <Frame name="StatLike"><Size><AbsDimension x="104" y="13"/></Size>
          <Scripts><OnEnter>x=1</OnEnter><OnLeave>x=2</OnLeave></Scripts>
        </Frame>
        <StatusBar name="BarLike"><Size><AbsDimension x="100" y="13"/></Size>
          <Scripts><OnEnter>x=3</OnEnter></Scripts>
        </StatusBar>
      </Ui>
    `);
    expect(report.errors).toEqual([]);
    // Both have their handler bound AND can now be reached by `hitTest`.
    expect(widget('StatLike').mouseEnabled).toBe(true);
    expect(widget('StatLike').onEnter).not.toBeNull();
    expect(widget('BarLike').mouseEnabled).toBe(true);
  });

  it('leaves a frame with no mouse script alone, and honours an explicit enableMouse="false"', () => {
    const { widget } = load(`
      <Ui>
        <Frame name="Plain"><Size><AbsDimension x="10" y="10"/></Size></Frame>
        <Frame name="OnlyOnEvent"><Size><AbsDimension x="10" y="10"/></Size>
          <Scripts><OnEvent>x=1</OnEvent><OnUpdate>x=2</OnUpdate></Scripts>
        </Frame>
        <Frame name="Refused" enableMouse="false"><Size><AbsDimension x="10" y="10"/></Size>
          <Scripts><OnEnter>x=3</OnEnter></Scripts>
        </Frame>
      </Ui>
    `);
    expect(widget('Plain').mouseEnabled).toBe(false);
    // `OnEvent`/`OnUpdate` are not mouse handlers -- arming on them would make every event-driven
    // frame in the manifest swallow clicks.
    expect(widget('OnlyOnEvent').mouseEnabled).toBe(false);
    // The document's own statement outranks an inference from its scripts.
    expect(widget('Refused').mouseEnabled).toBe(false);
  });
});
