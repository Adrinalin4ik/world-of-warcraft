import { DEFAULT_PARENT_NAME, TemplateRegistry, resolveName } from '../templates';
import { attr, childrenNamed, parseXml } from '../xml';

/** The single `<Ui>` child of a one-element document, as an owned element. */
function only(xml: string) {
  const item = parseXml(`<Ui>${xml}</Ui>`).items[0];
  return 'element' in item ? item.element : null!;
}

describe('TemplateRegistry', () => {
  it('merges a template inherited-first so the instance value is the LAST one', () => {
    const registry = new TemplateRegistry();
    registry.register(only('<Button name="Tmpl" virtual="true"><Size x="80" y="22"/></Button>'));

    const warnings: string[] = [];
    const expanded = registry.expand(only('<Button name="Real" inherits="Tmpl"><Size x="125" y="21"/></Button>'), warnings);

    const sizes = childrenNamed(expanded, 'Size');
    expect(sizes.map((s) => attr(s, 'x'))).toEqual(['80', '125']);
    expect(warnings).toEqual([]);
  });

  it('resolves a chain, with the leaf winning over the middle over the root', () => {
    const registry = new TemplateRegistry();
    registry.register(only('<Frame name="Root" virtual="true" alpha="0.1" hidden="true"/>'));
    registry.register(only('<Frame name="Mid" virtual="true" inherits="Root" alpha="0.5"/>'));

    const expanded = registry.expand(only('<Frame name="Leaf" inherits="Mid" alpha="0.9"/>'), []);

    expect(attr(expanded, 'alpha')).toBe('0.9');
    expect(attr(expanded, 'hidden')).toBe('true');
  });

});

// The cycle guard is implemented and commented but not tested -- an error path, per the plan's
// happy-path budget. Note what that costs: a cycle without the guard HANGS the suite rather than
// failing it. Keep the `active` set.


describe('resolveName', () => {
  it('substitutes $parent case-insensitively and appends the remainder verbatim', () => {
    expect(resolveName('$parentHealthBar', 'PlayerFrame')).toBe('PlayerFrameHealthBar');
    expect(resolveName('$PARENTText', 'MyBox')).toBe('MyBoxText');
  });

});
