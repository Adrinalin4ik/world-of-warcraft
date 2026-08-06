/**
 * FrameXML documents, as an owned tree.
 *
 * Re-materialized out of the DOM rather than held as `Element` nodes: the tree is walked repeatedly
 * during template expansion, which MERGES nodes from different documents, and a merged tree cannot
 * be a live DOM node from either of them.
 */
export type XmlElement = {
  tag: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  /** This element's OWN direct text and CDATA, never a descendant's -- a handler's Lua source. */
  body: string;
};

export type TopLevel =
  | { kind: 'include'; path: string }
  | { kind: 'script'; path: string }
  | { kind: 'inlineScript'; body: string }
  | { kind: 'font'; element: XmlElement }
  | { kind: 'template'; element: XmlElement }
  | { kind: 'instance'; element: XmlElement };

export type ParsedDocument = { items: TopLevel[]; errors: string[] };

export function attr(element: XmlElement, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of element.attrs) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/**
 * A boolean LoadXML attribute.
 *
 * `1` COUNTS, and that is not a convenience: the client's own XML writes both spellings, sometimes for
 * the same attribute in the same file. `accountlogin.xml:239` is `<EditBox name="AccountLoginPasswordEdit"
 * letters="16" password="1">` -- so a `true`-only reading left the login screen's password field
 * rendering what was typed in clear text. (`loader.ts#applyButton` already accepted both for `checked=`,
 * with its own regex, which is how the two spellings came to be half-handled in the first place.)
 *
 * Anything else, including `false` and `0`, is false.
 */
export function attrBool(element: XmlElement, name: string): boolean {
  const value = (attr(element, name) ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

export function childrenNamed(element: XmlElement, tag: string): XmlElement[] {
  const wanted = tag.toLowerCase();
  return element.children.filter((child) => child.tag.toLowerCase() === wanted);
}

function ownText(node: Element): string {
  let text = '';
  node.childNodes.forEach((child) => {
    // TEXT_NODE (3) and CDATA_SECTION_NODE (4). Element children are NOT descended into.
    if (child.nodeType === 3 || child.nodeType === 4) {
      text += child.nodeValue ?? '';
    }
  });
  return text;
}

function own(node: Element): XmlElement {
  const attrs = new Map<string, string>();
  for (let i = 0; i < node.attributes.length; i += 1) {
    const a = node.attributes[i];
    attrs.set(a.name, a.value);
  }
  return {
    tag: node.tagName,
    attrs,
    children: Array.from(node.children).map(own),
    body: ownText(node),
  };
}

/**
 * Classify a root child.
 *
 * The tag checks come FIRST, and that order is load-bearing. Every `<Font>` in the client's own
 * `gluefontstyles.xml` -- all 57 of them -- carries `virtual="true"`, because that is simply how a
 * font object is declared. Testing `virtual` before the tag would file every one of them into the
 * template registry and leave the font registry empty. Fonts and templates are two registries on
 * purpose: a font inherits a font, never a frame.
 *
 * `virtual="true"` therefore makes an element a template only when its tag is not already one of the
 * kinds above it -- which is what the client does, not a simplification. Unknown tags fall through
 * to `instance` on purpose: whether a tag names a real widget type is `CreateFrame`'s question, not
 * this parser's, and answering it here would mean this module knowing the widget vocabulary.
 */
function classify(element: XmlElement): TopLevel | null {
  const tag = element.tag.toLowerCase();

  if (tag === 'include') {
    const path = attr(element, 'file');
    return path ? { kind: 'include', path } : null;
  }
  if (tag === 'script') {
    const path = attr(element, 'file');
    return path ? { kind: 'script', path } : { kind: 'inlineScript', body: element.body };
  }
  if (tag === 'font') {
    return { kind: 'font', element };
  }
  if (attrBool(element, 'virtual')) {
    return { kind: 'template', element };
  }
  return { kind: 'instance', element };
}

export function parseXml(text: string): ParsedDocument {
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  // `DOMParser` does not throw on malformed XML -- it returns a document whose root is a
  // <parsererror>. Checking for it is the only way to notice, and noticing matters: the alternative
  // is materializing a screen out of an error message.
  const failure = doc.querySelector('parsererror');
  if (failure || !doc.documentElement) {
    return { items: [], errors: [`XML parse failed: ${failure?.textContent?.trim() ?? 'no root'}`] };
  }

  const items: TopLevel[] = [];
  for (const child of Array.from(doc.documentElement.children)) {
    const item = classify(own(child));
    if (item) {
      items.push(item);
    }
  }
  return { items, errors: [] };
}
