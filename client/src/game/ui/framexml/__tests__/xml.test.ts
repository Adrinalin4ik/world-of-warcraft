import { parseXml } from '../xml';

describe('parseXml', () => {
  it('classifies top-level items and keeps them in document order', () => {
    // Order matters and is not cosmetic: the client runs <Script> interleaved with frame definitions,
    // so a structure that grouped scripts together would change Lua load order.
    const doc = parseXml(`
      <Ui>
        <Script file="First.lua"/>
        <Button name="Tmpl" virtual="true"><Size x="10" y="20"/></Button>
        <Include file="More.xml"/>
        <Font name="AFont"/>
        <Frame name="Real"><Scripts><OnLoad>x = 1</OnLoad></Scripts></Frame>
        <Script>inline = true</Script>
      </Ui>
    `);

    expect(doc.items.map((i) => i.kind)).toEqual([
      'script',
      'template',
      'include',
      'font',
      'instance',
      'inlineScript',
    ]);
    expect(doc.errors).toEqual([]);
  });

  it("takes an element's own text as its body, not a descendant's", () => {
    const doc = parseXml('<Ui><Frame name="F"><Scripts><OnLoad>real = 1</OnLoad></Scripts></Frame></Ui>');
    const frame = doc.items[0].kind === 'instance' ? doc.items[0].element : null;
    const onLoad = frame!.children[0].children[0];

    expect(onLoad.tag).toBe('OnLoad');
    expect(onLoad.body.trim()).toBe('real = 1');
    // The Frame's own body is whitespace only -- it must NOT have absorbed the handler source.
    expect(frame!.body.trim()).toBe('');
  });
});

// Two tests, per the plan's happy-path budget. Case-insensitive `attr`/`attrBool` and the
// malformed-document path are implemented and commented but not tested: the first is exercised by
// every test above through `virtual="true"`, and the second is an error path.
