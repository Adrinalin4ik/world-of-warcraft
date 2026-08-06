# FrameXML Document Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the game client's own `.toc` and XML, resolve its templates, and order the screen the way the client orders it — everything the FrameXML runtime needs that involves no Lua.

**Architecture:** Four pure modules under `client/src/game/ui/framexml/`, plus one breaking change to the existing widget layer. `toc.ts` and `xml.ts` turn client data into owned, order-preserving trees. `templates.ts` resolves `virtual`/`inherits`/`$parent`. `order.ts` replaces the draw-list comparator with the client's packed sort key, which means splitting frame *strata* out of the draw *layer* they are currently conflated with. No file here opens a socket, touches Lua, or knows what a screen is.

**Tech Stack:** TypeScript, `DOMParser` (browser-native, already available in jsdom for tests), jest. No new runtime dependency in this plan — fengari arrives in the plan that follows.

**Spec:** `docs/superpowers/specs/2026-08-06-framexml-runtime-design.md` (§4 pipeline, §5 templates, §6 draw order). Read §5 and §6 before Task 3 and Task 4 respectively; both sections list bugs that the reference implementation shipped first, and each is a bug this plan is written to avoid.

**This is plan 1 of 2.** It delivers the document layer and the corrected draw order, verifiable on their own. Plan 2 adds fengari, the object model, the ~60 frame methods, the ~89 engine globals, and the loader that joins them.

## Global Constraints

- **Reference fidelity.** Every rule here is transcribed from `samples/benilla/crates/benilla-ui`, which is a port of the real client. Where this plan states a rule with a reason attached, the reason is the bug that rule prevents — keep it in the comment. Where something is ours rather than the client's, the comment must say so.
- **Never throw on bad input.** A missing include, an unknown tag, an unresolvable inherit, a cycle: each is an entry in a report and processing continues. The client logs and continues; so do we.
- **No IO in these modules.** Files arrive through an injected `(path: string) => string | null` resolver. This is what makes the whole layer testable from inline strings.
- **Order is preserved everywhere.** `.toc` entries, XML top-level items, template merge results. The client interleaves script execution with frame definitions in document order and Lua load order depends on it; a "tidier" split-by-kind structure loses that and is wrong.
- **Essential tests only** — the project owner's standing instruction: happy path, plus a regression test when something actually breaks. Task 4 is the one exception, stated in that task, because there the tests *are* the specification.
- `cd client && npx tsc --noEmit -p tsconfig.json` at zero errors and `cd client && npm test -- --watchAll=false` green after every task. The suite is at 135 suites / 1632 tests before this plan.
- Watch for a typographic apostrophe (U+2019) inside single-quoted strings — it has broken this repo's parser on four separate occasions. Straight apostrophes or double quotes.

## File Structure

| File | Responsibility |
|---|---|
| `client/src/game/ui/framexml/toc.ts` | Parse a `.toc` manifest into ordered directives and file entries. |
| `client/src/game/ui/framexml/xml.ts` | Parse an XML document into an owned, order-preserving tree; classify top-level items. |
| `client/src/game/ui/framexml/templates.ts` | The template registry, `inherits` expansion, and `$parent` resolution. |
| `client/src/game/ui/framexml/order.ts` | The packed draw-order key and the traversal that sorts by it. |
| `client/src/game/ui/widget.ts` | **Modified.** `Layer` loses `DIALOG`; `Widget` gains `strata`, `frameLevel`, and a link-stamp; `drawList` delegates to `order.ts`. |
| `client/src/game/ui/screens/login.ts`, `screens/realms.ts` | **Modified.** The two screens that set `layer = 'DIALOG'` move to `strata = 'DIALOG'`. |

---

### Task 1: The `.toc` parser

`gluexml.toc` is the manifest that gives the load order. It is a trivial format and a trivial parser, which is exactly why it is first: it establishes the module's shape and its no-throw contract with almost no surface.

**Files:**
- Create: `client/src/game/ui/framexml/toc.ts`
- Test: `client/src/game/ui/framexml/__tests__/toc.test.ts`

**Interfaces:**
- Produces:
  - `export type Toc = { directives: Array<[string, string]>; files: string[] }`
  - `export function parseToc(text: string): Toc`
  - `export function tocDirective(toc: Toc, key: string): string | null` — case-insensitive, first wins.

- [ ] **Step 1: Write the failing test**

```ts
import { parseToc, tocDirective } from '../toc';

describe('parseToc', () => {
  it('keeps directives and files in the order the manifest lists them', () => {
    // The real gluexml.toc, abridged. Note the `##Debug` line: a directive with no colon is a
    // COMMENT, not a file, or the loader would try to fetch "##DebugHook.lua".
    const toc = parseToc(
      [
        '## Interface: 30300',
        '##DebugHook.lua',
        'GlueStrings.lua',
        'GlueFonts.xml',
        '',
        '## add new files after here',
        'AccountLogin.xml',
      ].join('\n'),
    );

    expect(toc.files).toEqual(['GlueStrings.lua', 'GlueFonts.xml', 'AccountLogin.xml']);
    expect(tocDirective(toc, 'interface')).toBe('30300');
  });

  it('returns null for a directive the manifest does not carry', () => {
    expect(tocDirective(parseToc('Only.lua'), 'Title')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/toc`
Expected: FAIL, "Cannot find module '../toc'".

- [ ] **Step 3: Implement**

```ts
/**
 * The `.toc` manifest: which files a UI package loads, and in what order.
 *
 * Load ORDER is the whole point. The client executes these in sequence, and a template registered by
 * an earlier file is what a later file's `inherits=` resolves against, so a parser that returned a
 * set rather than a list would silently break cross-file inheritance.
 *
 * Never throws. A malformed line is not an error in the client either -- it logs and continues.
 */
export type Toc = {
  /** `## Key: Value` lines, in order. */
  directives: Array<[string, string]>;
  /** File entries, in load order. */
  files: string[];
};

export function parseToc(text: string): Toc {
  const directives: Array<[string, string]> = [];
  const files: string[] = [];

  // A UTF-8 BOM survives the fetch and would otherwise become part of the first entry's name.
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('#')) {
      // `## Key: Value` is a directive. Anything else beginning with `#` is a comment -- including
      // `##DebugHook.lua`, which the real gluexml.toc uses to comment a file OUT. Treating it as a
      // file would send the loader after a path that does not exist.
      const match = /^##\s*([^:]+):\s*(.*)$/.exec(line);
      if (match) {
        directives.push([match[1].trim(), match[2].trim()]);
      }
      continue;
    }

    files.push(line);
  }

  return { directives, files };
}

/** A directive by name, case-insensitively, first occurrence winning. Null when absent. */
export function tocDirective(toc: Toc, key: string): string | null {
  const wanted = key.toLowerCase();
  const found = toc.directives.find(([name]) => name.toLowerCase() === wanted);
  return found ? found[1] : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/toc`
Expected: PASS, 2 tests.

- [ ] **Step 5: Type check and commit**

```bash
cd client && npx tsc --noEmit -p tsconfig.json
git add client/src/game/ui/framexml
git commit -m "feat(framexml): parse a .toc manifest, preserving load order"
```

---

### Task 2: The XML document parser

Turn XML text into an owned tree and classify the root's children. The classification is the interesting part and the ordering rule is load-bearing.

**Files:**
- Create: `client/src/game/ui/framexml/xml.ts`
- Test: `client/src/game/ui/framexml/__tests__/xml.test.ts`

**Interfaces:**
- Produces:
  - `export type XmlElement = { tag: string; attrs: Map<string, string>; children: XmlElement[]; body: string }`
  - `export type TopLevel = { kind: 'include'; path: string } | { kind: 'script'; path: string } | { kind: 'inlineScript'; body: string } | { kind: 'font'; element: XmlElement } | { kind: 'template'; element: XmlElement } | { kind: 'instance'; element: XmlElement }`
  - `export type ParsedDocument = { items: TopLevel[]; errors: string[] }`
  - `export function parseXml(text: string): ParsedDocument`
  - `export function attr(element: XmlElement, name: string): string | undefined` — case-insensitive lookup.
  - `export function attrBool(element: XmlElement, name: string): boolean` — case-insensitive on name *and* value; `"true"` only.
  - `export function childrenNamed(element: XmlElement, tag: string): XmlElement[]` — case-insensitive.

**Notes for the implementer:**
- Use the browser-native `DOMParser`. jsdom provides it under jest, so no dependency and no polyfill.
- `body` is the element's **own direct text and CDATA only**, never a descendant's. That is where a `<OnLoad>` handler's Lua source lives, and including descendant text would concatenate a nested element's content into the script.
- Attribute names in FrameXML are inconsistently cased across files; every lookup is case-insensitive.

- [ ] **Step 1: Write the failing test**

```ts
import { attr, attrBool, parseXml } from '../xml';

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

  it('takes an element's own text as its body, not a descendant's', () => {
    const doc = parseXml('<Ui><Frame name="F"><Scripts><OnLoad>real = 1</OnLoad></Scripts></Frame></Ui>');
    const frame = doc.items[0].kind === 'instance' ? doc.items[0].element : null;
    const onLoad = frame!.children[0].children[0];

    expect(onLoad.tag).toBe('OnLoad');
    expect(onLoad.body.trim()).toBe('real = 1');
    // The Frame's own body is whitespace only -- it must NOT have absorbed the handler source.
    expect(frame!.body.trim()).toBe('');
  });

  it('reads attributes case-insensitively, on the name and on a bool value', () => {
    const doc = parseXml('<Ui><Frame NAME="F" virtual="TRUE" hidden="false"/></Ui>');
    // `TopLevel` is a union and only three of its members carry an element, so narrow rather than
    // asserting -- `doc.items[0].element` does not type-check.
    const item = doc.items[0];
    const frame = 'element' in item ? item.element : null!;

    expect(attr(frame, 'name')).toBe('F');
    expect(attrBool(frame, 'VIRTUAL')).toBe(true);
    expect(attrBool(frame, 'hidden')).toBe(false);
    expect(attrBool(frame, 'absent')).toBe(false);
  });

  it('reports a parse failure instead of throwing', () => {
    const doc = parseXml('<Ui><Frame></Ui>');

    expect(doc.items).toEqual([]);
    expect(doc.errors.length).toBe(1);
  });
});
```

Note for the implementer: the second test's name contains an apostrophe inside a single-quoted
string. Write it with double quotes — `it("takes an element's own text ...")` — or it will not parse.
This is the fifth time this has bitten the repo.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/xml`
Expected: FAIL, "Cannot find module '../xml'".

- [ ] **Step 3: Implement**

```ts
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

export function attrBool(element: XmlElement, name: string): boolean {
  return (attr(element, name) ?? '').toLowerCase() === 'true';
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
 * `virtual="true"` makes an element a TEMPLATE regardless of its tag -- a virtual `<Button>` is a
 * template, not a button. Unknown tags fall through to `instance` on purpose: whether a tag names a
 * real widget type is `CreateFrame`'s question, not this parser's, and answering it here would mean
 * this module knowing the widget vocabulary.
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/xml`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd client && npx tsc --noEmit -p tsconfig.json
git add client/src/game/ui/framexml
git commit -m "feat(framexml): parse a document into an owned, order-preserving tree"
```

---

### Task 3: Template expansion and `$parent`

The part with the most bugs attached. Spec §5 lists them; each rule below names the failure it prevents.

**Files:**
- Create: `client/src/game/ui/framexml/templates.ts`
- Test: `client/src/game/ui/framexml/__tests__/templates.test.ts`

**Interfaces:**
- Consumes: `XmlElement`, `attr`, `attrBool` from `./xml`.
- Produces:
  - `export class TemplateRegistry { register(element: XmlElement): void; has(name: string): boolean; expand(element: XmlElement, warnings: string[]): XmlElement }`
  - `export function resolveName(raw: string | undefined, parentName: string): string | undefined`
  - `export const DEFAULT_PARENT_NAME = 'Top'`

**The rules, each with its reason:**

1. **The registry is global and lives across documents.** `RealmList.xml` inherits templates from
   `GlueTemplates.xml`. A per-document registry silently drops every cross-file inherit.
2. **An unnamed `virtual` element is warned and not registered** — nothing could inherit it anyway.
3. **Merge is inherited-first, own-last.** Template children come first, the element's own children
   appended after. Attributes: the template's, then the element's overriding by case-insensitive name.
   **Consumers must therefore take the LAST matching child, never the first** — an instance's `<Size>`
   is the second `<Size>`. Taking the first pinned a 125×21 button to its template's 80×22.
4. **`inherits="A, B"`** splits on commas, trims, and merges left to right, so B beats A and the
   element beats both.
5. **Chains recurse** — each named template is itself expanded before being merged.
6. **Cycles warn and skip**, guarded by the set of names currently being expanded.
7. **Body**: the element's own body if non-empty, else the template's — so a template's `<OnLoad>`
   survives into an instance that declares none.
8. **`$parent`** is a case-insensitive 7-character prefix match; the remainder appends verbatim.
   Not a prefix match means unchanged. Only `name` is substituted, never `parent`.

- [ ] **Step 1: Write the failing test**

```ts
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

  it('warns and terminates on a cycle instead of recursing forever', () => {
    const registry = new TemplateRegistry();
    registry.register(only('<Frame name="A" virtual="true" inherits="B"/>'));
    registry.register(only('<Frame name="B" virtual="true" inherits="A"/>'));

    const warnings: string[] = [];
    registry.expand(only('<Frame name="Use" inherits="A"/>'), warnings);

    expect(warnings.some((w) => /cycle/i.test(w))).toBe(true);
  });
});

describe('resolveName', () => {
  it('substitutes $parent case-insensitively and appends the remainder verbatim', () => {
    expect(resolveName('$parentHealthBar', 'PlayerFrame')).toBe('PlayerFrameHealthBar');
    expect(resolveName('$PARENTText', 'MyBox')).toBe('MyBoxText');
  });

  it('leaves a name that does not start with the token alone', () => {
    expect(resolveName('Standalone', 'PlayerFrame')).toBe('Standalone');
    expect(resolveName(undefined, 'PlayerFrame')).toBeUndefined();
    expect(resolveName('$parentX', DEFAULT_PARENT_NAME)).toBe('TopX');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/templates`
Expected: FAIL, "Cannot find module '../templates'".

- [ ] **Step 3: Implement**

```ts
import { XmlElement, attr, attrBool } from './xml';

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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/templates`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd client && npx tsc --noEmit -p tsconfig.json
git add client/src/game/ui/framexml
git commit -m "feat(framexml): expand inherits templates and resolve \$parent"
```

---

### Task 4: The draw-order key

**Read spec §6 before starting.** This is the one task where the tests are the specification rather than a happy-path sample, and the project owner's minimal-tests instruction is explicitly suspended for it: every rule below is counterintuitive, invisible in a screenshot until it is wrong, and misdiagnoses as an art bug rather than a sort bug.

**Files:**
- Create: `client/src/game/ui/framexml/order.ts`
- Test: `client/src/game/ui/framexml/__tests__/order.test.ts`

**Interfaces:**
- Produces:
  - `export type Strata = 'BACKGROUND' | 'LOW' | 'MEDIUM' | 'HIGH' | 'DIALOG' | 'FULLSCREEN' | 'FULLSCREEN_DIALOG' | 'TOOLTIP'`
  - `export const STRATA_ORDER: Strata[]`
  - `export type DrawLayer = 'BACKGROUND' | 'BORDER' | 'ARTWORK' | 'OVERLAY' | 'HIGHLIGHT'`
  - `export const DRAW_LAYER_ORDER: DrawLayer[]`
  - `export type OrderKey = { strata: Strata; frameLevel: number; layer: DrawLayer; isFontString: boolean; linkStamp: number; declarationSeq: number }`
  - `export function compareOrder(a: OrderKey, b: OrderKey): number`

**Why a comparator and not a packed integer:** benilla packs these into a `u64` because Rust sorts
integers fastest. JS has no u64 — `BigInt` would allocate per widget per frame, which is exactly the
per-frame garbage the renderer's mesh pool exists to avoid. A field-by-field comparator is the same
total order with no allocation. Say so in the file comment; the packing is an implementation detail
of the reference, the *order* is the contract.

**The order, most significant first:**

| rank | field | note |
|---|---|---|
| 1 | `strata` | 8 values, BACKGROUND lowest |
| 2 | `frameLevel` | number |
| 3 | `layer` | **outranks the frame** — every frame's BACKGROUND, then every frame's BORDER |
| 4 | `isFontString` | textures before font strings, across frames |
| 5 | `linkStamp` | live list position, not creation order |
| 6 | `declarationSeq` | index within the owning frame |

- [ ] **Step 1: Write the failing tests — one per rank, plus the interleave regression**

```ts
import { OrderKey, compareOrder } from '../order';

const key = (over: Partial<OrderKey> = {}): OrderKey => ({
  strata: 'MEDIUM',
  frameLevel: 0,
  layer: 'ARTWORK',
  isFontString: false,
  linkStamp: 0,
  declarationSeq: 0,
  ...over,
});

/** Sort a labelled set and read back the labels, which is what every test below asserts on. */
const order = (entries: Array<[string, Partial<OrderKey>]>): string[] =>
  entries
    .map(([label, over]) => ({ label, k: key(over) }))
    .sort((a, b) => compareOrder(a.k, b.k))
    .map((e) => e.label);

describe('compareOrder', () => {
  it('ranks strata above everything else', () => {
    expect(
      order([
        ['dialog', { strata: 'DIALOG', frameLevel: 0, layer: 'BACKGROUND' }],
        ['medium', { strata: 'MEDIUM', frameLevel: 99, layer: 'HIGHLIGHT' }],
      ]),
    ).toEqual(['medium', 'dialog']);
  });

  it('ranks frame level above the draw layer', () => {
    expect(
      order([
        ['high-level-background', { frameLevel: 2, layer: 'BACKGROUND' }],
        ['low-level-highlight', { frameLevel: 1, layer: 'HIGHLIGHT' }],
      ]),
    ).toEqual(['low-level-highlight', 'high-level-background']);
  });

  it('interleaves frames by layer rather than grouping regions behind their frame', () => {
    // THE regression test. The intuitive model -- draw frame A whole, then frame B whole -- is wrong.
    // Within one (strata, level) bucket the layer outranks the frame, so every frame's BACKGROUND
    // draws before any frame's ARTWORK. benilla shipped the intuitive version and a status bar's fill
    // painted over its own border.
    expect(
      order([
        ['A.artwork', { layer: 'ARTWORK', linkStamp: 0 }],
        ['A.background', { layer: 'BACKGROUND', linkStamp: 0 }],
        ['B.artwork', { layer: 'ARTWORK', linkStamp: 1 }],
        ['B.background', { layer: 'BACKGROUND', linkStamp: 1 }],
      ]),
    ).toEqual(['A.background', 'B.background', 'A.artwork', 'B.artwork']);
  });

  it('draws every texture of a layer before any of its font strings', () => {
    expect(
      order([
        ['A.text', { isFontString: true, linkStamp: 0 }],
        ['B.tex', { isFontString: false, linkStamp: 1 }],
        ['A.tex', { isFontString: false, linkStamp: 0 }],
        ['B.text', { isFontString: true, linkStamp: 1 }],
      ]),
    ).toEqual(['A.tex', 'B.tex', 'A.text', 'B.text']);
  });

  it('orders by link stamp, then by declaration order within one frame', () => {
    expect(
      order([
        ['later-frame.first-region', { linkStamp: 5, declarationSeq: 0 }],
        ['earlier-frame.second-region', { linkStamp: 1, declarationSeq: 1 }],
        ['earlier-frame.first-region', { linkStamp: 1, declarationSeq: 0 }],
      ]),
    ).toEqual([
      'earlier-frame.first-region',
      'earlier-frame.second-region',
      'later-frame.first-region',
    ]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/order`
Expected: FAIL, "Cannot find module '../order'".

- [ ] **Step 3: Implement**

```ts
/**
 * The client's draw order, as one total order over a per-quad key.
 *
 * THE ORDER IS FLAT, NOT HIERARCHICAL. There is no "draw a frame, then its children" walk: every
 * visible quad is an independent entry ranked by this key, so a child frame in a lower strata draws
 * BEFORE its parent.
 *
 * Two ranks in here are counterintuitive and both have a visual signature that reads as an art bug:
 *
 *  - The DRAW LAYER outranks the frame. A bucket emits every frame's BACKGROUND, then every frame's
 *    BORDER, and so on -- regions are not grouped behind the frame that owns them. This is also why
 *    `SetFrameLevel(GetFrameLevel() - 1)` is a real FrameXML idiom: a child is born at parent + 1, so
 *    -1 makes a TIE, and the tie exists precisely so the layer rank can decide.
 *  - All textures of a layer precede all its font strings, across frames.
 *
 * benilla packs these fields into a u64 and sorts integers. JS has no u64, and a BigInt per quad per
 * frame is exactly the allocation the renderer's mesh pool exists to avoid -- so this is a
 * field-by-field comparator instead. Same total order, no garbage. The packing is the reference's
 * implementation detail; the ORDER is the contract.
 */

/** Frame strata, lowest first. A separate and higher-ranked axis than the draw layer. */
export type Strata =
  | 'BACKGROUND'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'DIALOG'
  | 'FULLSCREEN'
  | 'FULLSCREEN_DIALOG'
  | 'TOOLTIP';

export const STRATA_ORDER: Strata[] = [
  'BACKGROUND',
  'LOW',
  'MEDIUM',
  'HIGH',
  'DIALOG',
  'FULLSCREEN',
  'FULLSCREEN_DIALOG',
  'TOOLTIP',
];

/** The five draw layers within a frame level. NOT a place for DIALOG -- that is a strata. */
export type DrawLayer = 'BACKGROUND' | 'BORDER' | 'ARTWORK' | 'OVERLAY' | 'HIGHLIGHT';

export const DRAW_LAYER_ORDER: DrawLayer[] = [
  'BACKGROUND',
  'BORDER',
  'ARTWORK',
  'OVERLAY',
  'HIGHLIGHT',
];

export type OrderKey = {
  strata: Strata;
  frameLevel: number;
  layer: DrawLayer;
  isFontString: boolean;
  /**
   * The owning frame's position in its bucket's live list -- NOT its creation index. Re-stamped to
   * the tail when a frame is shown, changes strata, or has its level CHANGED (a same-value
   * `SetFrameLevel` must not re-stamp). Without this, a frame declared early and shown late draws
   * under what it should cover.
   */
  linkStamp: number;
  /** The region's index within the frame that owns it. */
  declarationSeq: number;
};

export function compareOrder(a: OrderKey, b: OrderKey): number {
  return (
    STRATA_ORDER.indexOf(a.strata) - STRATA_ORDER.indexOf(b.strata) ||
    a.frameLevel - b.frameLevel ||
    DRAW_LAYER_ORDER.indexOf(a.layer) - DRAW_LAYER_ORDER.indexOf(b.layer) ||
    Number(a.isFontString) - Number(b.isFontString) ||
    a.linkStamp - b.linkStamp ||
    a.declarationSeq - b.declarationSeq
  );
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=framexml/__tests__/order`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd client && npx tsc --noEmit -p tsconfig.json
git add client/src/game/ui/framexml
git commit -m "feat(framexml): the client's draw order as one total order"
```

---

### Task 5: Split strata out of layer, and sort the draw list by the real key

The breaking change. `Layer` currently carries `DIALOG`, which is a strata masquerading as a draw
layer; the two screens that use it move to `strata`, and `drawList` starts sorting by `compareOrder`.

**Files:**
- Modify: `client/src/game/ui/widget.ts` — `Layer`, `LAYER_ORDER`, `Widget`, `WidgetRoot#drawList`
- Modify: `client/src/game/ui/screens/login.ts` — the dialog widget
- Modify: `client/src/game/ui/screens/realms.ts` — the panel and its dim
- Test: `client/src/game/ui/__tests__/widget.test.ts` (existing file — add one case)

**Interfaces:**
- Consumes: `DrawLayer`, `Strata`, `OrderKey`, `compareOrder` from `./framexml/order`.
- Produces: `Widget#strata: Strata`, `Widget#frameLevel: number`, `Widget#linkStamp: number`;
  `Layer` is re-exported as an alias of `DrawLayer` so existing imports keep compiling.

**What changes, precisely:**

1. `export type Layer = DrawLayer` — re-exported from `order.ts`, so `'DIALOG'` stops being assignable
   and `tsc` finds every site that needs moving. That is the point of doing it this way: the compiler
   produces the work list.
1b. **`LAYER_ORDER` goes.** It currently lists six layers including `DIALOG` and `drawList` was its
   only real consumer. Re-export `DRAW_LAYER_ORDER` from `order.ts` under the old name
   (`export { DRAW_LAYER_ORDER as LAYER_ORDER }`) if anything else imports it — check with
   `grep -rn "LAYER_ORDER" client/src` first and say in your report what you found. Two definitions of
   the layer ladder that can drift apart is the thing to avoid; one of them must be the only one.
2. `Widget` gains `strata: Strata = 'MEDIUM'`, `frameLevel = 0`, and `linkStamp = 0`.
3. A child created under a parent inherits the parent's strata and is born at `parent.frameLevel + 1`.
   This is the rule that makes `SetFrameLevel(GetFrameLevel() - 1)` work later, and skipping it makes
   a DIALOG-strata panel draw its backdrop over its own buttons.
4. `drawList` builds an `OrderKey` per widget and sorts with `compareOrder`. `linkStamp` is the
   owning frame's DFS index for now — a static stand-in for the live list position, which arrives with
   `Show`/`SetFrameStrata`/`SetFrameLevel` in plan 2. **Comment it as a stand-in**, or the next reader
   will take DFS order for the client's rule.
5. `isFontString` is `widget.kind === 'fontstring'`.

- [ ] **Step 1: Move the two DIALOG users to strata**

In `login.ts`, the dialog is created with `this.dialog.layer = 'DIALOG'`. Replace with:

```ts
    // DIALOG is a frame STRATA, not a draw layer -- it outranks every layer of every MEDIUM frame,
    // which is what puts this panel over the whole screen rather than merely over its own siblings.
    this.dialog.strata = 'DIALOG';
    this.dialog.layer = 'BACKGROUND';
```

Its children (`login-dialog-text`, the button) keep their own layers and inherit the strata.

In `realms.ts`, do the same for the full-screen dim and the panel: `strata = 'DIALOG'`, and give each
its authored layer from the XML (`BACKGROUND` for the dim, `BACKGROUND`/`ARTWORK` for the panel art).

- [ ] **Step 2: Write the failing test**

Append to `client/src/game/ui/__tests__/widget.test.ts`:

```ts
  it('draws a DIALOG-strata frame over a MEDIUM frame whatever their layers say', () => {
    const root = new WidgetRoot();

    const behind = root.root.add(new Widget('texture', 'behind'));
    behind.layer = 'HIGHLIGHT';
    behind.setSize(10, 10).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

    const dialog = root.root.add(new Widget('texture', 'dialog'));
    dialog.strata = 'DIALOG';
    dialog.layer = 'BACKGROUND';
    dialog.setSize(10, 10).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

    const ids = root.drawList({ width: 1024, height: 768 }).map((item) => item.widget.id);

    expect(ids.indexOf('dialog')).toBeGreaterThan(ids.indexOf('behind'));
  });
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=ui/__tests__/widget`
Expected: FAIL — `strata` is not a property of `Widget`.

- [ ] **Step 4: Implement**

In `widget.ts`: re-export the layer type, add the three fields, inherit strata and level in `add`, and
replace the sort in `drawList`:

```ts
import { DrawLayer, OrderKey, Strata, compareOrder } from './framexml/order';

/** The five FrameXML draw layers. DIALOG is NOT here -- it is a `Strata`; see `framexml/order.ts`. */
export type Layer = DrawLayer;
export type { Strata };
```

In `Widget`:

```ts
  /** Frame strata -- a higher-ranked axis than `layer`. Inherited from the parent on `add`. */
  strata: Strata = 'MEDIUM';
  /** Born at the parent's level + 1; see `framexml/order.ts` for why the tie matters. */
  frameLevel = 0;
```

In `add`, after parenting:

```ts
    child.strata = this.strata;
    child.frameLevel = this.frameLevel + 1;
```

In `drawList`, replace the `.sort(...)` with:

```ts
      .sort((a, b) => compareOrder(orderKey(a), orderKey(b)))
```

and above it:

```ts
/**
 * `linkStamp` is the widget's DFS index -- a STAND-IN for the client's live list position, which is
 * re-stamped to the bucket tail when a frame is shown or its strata/level changes. Static DFS order
 * is right for a screen built once and never re-shown, which is every screen today. `Show` and
 * `SetFrameLevel` make it live in plan 2; until then, do not read this as the client's rule.
 */
const orderKey = (entry: { widget: Widget; sequence: number }): OrderKey => ({
  strata: entry.widget.strata,
  frameLevel: entry.widget.frameLevel,
  layer: entry.widget.layer,
  isFontString: entry.widget.kind === 'fontstring',
  linkStamp: entry.sequence,
  declarationSeq: 0,
});
```

- [ ] **Step 5: Fix every site tsc reports**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`

Every remaining error is a `layer = 'DIALOG'` assignment. Each is a real decision — is that widget a
dialog-strata frame, or did it want a high layer? — so read the surrounding code rather than
find-replacing. Expect them in `login.ts` and `realms.ts` only.

- [ ] **Step 6: Run the whole suite**

Run: `cd client && npm test -- --watchAll=false`
Expected: 136 suites, all green. `isFontString` reorders font strings after textures within a layer,
which is a real visual change; if an existing test asserts the old order, that test was pinning the
bug — update it and say which in the commit.

- [ ] **Step 7: Verify in the browser, because this task changes what is on screen**

The project owner's dev server runs on port 3000; do not start another. With it running, load `/` and
compare against `docs/`-referenced screenshots or the owner's own: the login screen's dialog must
still cover the account box, the realm list's panel must still sit over its dim, and the Okay/Cancel
buttons must still show their captions above their art. A font string vanishing behind a texture is
the signature of rank 4 being wrong.

- [ ] **Step 8: Commit**

```bash
git add client/src/game/ui
git commit -m "feat(ui): sort the draw list by the client's real order key"
```

---

## Done criteria

- `parseToc` reads `gluexml.toc` into 27 files in load order, and `tocDirective(toc, 'Interface')` answers.
- `parseXml` classifies `<Include>`, `<Script>`, `<Font>`, virtual templates and instances in document order, and reports a malformed document rather than throwing.
- `TemplateRegistry` resolves a chain, merges inherited-first so the instance's `<Size>` is last, warns on a cycle, and survives across documents.
- `resolveName` substitutes `$parent` case-insensitively against the nearest named ancestor.
- `compareOrder` implements all six ranks, with a test each and the interleave regression.
- `Layer` no longer contains `DIALOG`; `Widget` carries `strata`, `frameLevel` and `linkStamp`; `drawList` sorts by `compareOrder`.
- `npx tsc --noEmit` at zero, the full suite green, and `/` renders unchanged in a real browser apart from the intended font-string ordering.

## Follow-ups this plan deliberately leaves

- **`linkStamp` is static DFS order**, not the live list position. It becomes live in plan 2 with `Show`, `SetFrameStrata` and `SetFrameLevel`; the comment in `drawList` says so.
- **`declarationSeq` is always 0.** Nothing creates regions with an index yet — the loader does, in plan 2.
- **Sub-level** (`SetDrawLayer`'s second argument) is not in `OrderKey`. It is inert on 3.3.5 the same way it is on 1.12, and adding an always-zero field now would be a field nobody can test.
