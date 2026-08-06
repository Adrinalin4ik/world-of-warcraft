import { XmlElement, attr } from './xml';

/**
 * The name a `$parent` token resolves against when there is no named ancestor.
 *
 * The client's own literal, not a placeholder we chose.
 */
export const DEFAULT_PARENT_NAME = 'Top';

const TOKEN_LENGTH = '$parent'.length;

export function resolveName(raw: string | undefined, parentName: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.slice(0, TOKEN_LENGTH).toLowerCase() !== '$parent') {
    return raw;
  }
  return parentName + raw.slice(TOKEN_LENGTH);
}

function clone(element: XmlElement): XmlElement {
  return {
    tag: element.tag,
    attrs: new Map(element.attrs),
    children: element.children.map(clone),
    body: element.body,
  };
}

/**
 * `over` layered on `base`: base's children first, then over's; over's attributes winning by
 * case-insensitive name.
 *
 * The child ORDER is the contract every consumer depends on. `<Size>`, `<FontHeight>`, `<Color>` and
 * `<Shadow>` may all appear in both, and the override is the LAST one -- so a consumer that reads the
 * first match silently gets the template's value. That is not hypothetical: it pinned every templated
 * frame to its template's size until it was found on a button that declared 125x21 and drew 80x22.
 *
 * `name`, `virtual` and `inherits` are attributes like any other, so they splice through this same
 * rule: an element that omits `name` while inheriting a NAMED virtual template comes out carrying
 * the template's `name` *and* `virtual="true"`. `<NormalTexture inherits="GluePanelButtonUpTexture"/>`
 * is a concrete case of it (`GluePanelButtonUpTexture` is `<Texture name="..." virtual="true">`,
 * gluebuttons.xml:24) -- the merged element ends up named "GluePanelButtonUpTexture" and virtual,
 * even though the source line never says either. This is transcribed behaviour, not a decision we
 * made: the reference does exactly this (`samples/benilla/crates/benilla-ui/src/framexml.rs:259-269`)
 * and flags it as an unverified edge case rather than a silent guess -- real FrameXML apparently
 * never hits this case (an instance either names itself or stays anonymous), so it is inert in
 * practice, but we do not special-case it away, because diverging from the reference silently would
 * be worse than inheriting its caveat.
 */
function merge(base: XmlElement, over: XmlElement): XmlElement {
  const attrs = new Map(base.attrs);
  for (const [key, value] of over.attrs) {
    for (const existing of Array.from(attrs.keys())) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        attrs.delete(existing);
      }
    }
    attrs.set(key, value);
  }

  return {
    tag: over.tag,
    attrs,
    children: [...base.children.map(clone), ...over.children.map(clone)],
    // A template's <OnLoad> survives into an instance that declares none.
    body: over.body.trim() ? over.body : base.body,
  };
}

export class TemplateRegistry {
  /**
   * GLOBAL and cross-document on purpose: a file may inherit a template an EARLIER file registered
   * (RealmList.xml inherits GlueTemplates.xml's). A per-document registry drops every such inherit,
   * silently -- the element still materializes, just with none of the template's content.
   */
  private readonly templates = new Map<string, XmlElement>();

  register(element: XmlElement): void {
    const name = attr(element, 'name');
    if (!name) {
      // The real client warns "Unnamed virtual node" here. Nothing can inherit it, so there is
      // nothing to store.
      return;
    }
    this.templates.set(name.toLowerCase(), clone(element));
  }

  has(name: string): boolean {
    return this.templates.has(name.toLowerCase());
  }

  /**
   * Resolves the TOP element's own `inherits=` only -- it does not walk into `element`'s children.
   * A nested `inherits=` (the overwhelming majority of the 377 in the glue XML) is left for the
   * caller to expand when it materializes that child, matching the reference.
   */
  expand(element: XmlElement, warnings: string[]): XmlElement {
    return this.expandInner(element, warnings, new Set());
  }

  private expandInner(element: XmlElement, warnings: string[], active: Set<string>): XmlElement {
    const inherits = attr(element, 'inherits');
    if (!inherits) {
      return clone(element);
    }

    let base: XmlElement | null = null;
    for (const raw of inherits.split(',')) {
      const name = raw.trim();
      if (!name) {
        continue;
      }

      const key = name.toLowerCase();
      if (active.has(key)) {
        warnings.push(`template cycle: "${name}" inherits itself, skipping that reference`);
        continue;
      }

      const template = this.templates.get(key);
      if (!template) {
        // Not necessarily an error: on a <FontString>, `inherits=` names a FONT OBJECT, which lives
        // in a different registry entirely. The caller checks `has()` before deciding.
        warnings.push(`unknown template "${name}"`);
        continue;
      }

      active.add(key);
      const expanded = this.expandInner(template, warnings, active);
      active.delete(key);

      // Left to right, so a later name in `inherits="A, B"` wins.
      base = base ? merge(base, expanded) : expanded;
    }

    // The element itself last, so it beats everything it inherits.
    return base ? merge(base, element) : clone(element);
  }
}
