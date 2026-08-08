/**
 * A console interface for the FrameXML document layer, in the style of `skyDebug`.
 *
 * This layer has no callers yet -- the loader that consumes it arrives with the Lua runtime -- so
 * there is nothing on screen to look at and no way to tell whether it works against the real client
 * files rather than against the small fixtures its tests use. That gap is what this closes: every
 * command below runs the real modules over real data fetched from the asset host, and prints what came
 * back.
 *
 * Deliberately kept as a debug surface rather than a test. The tests pin behaviour on fixtures we
 * control, on purpose; this answers the different question of whether the client's own 31-file glue
 * manifest and its 30 KB of XML actually go through.
 *
 *   framexml.help()
 */
import Loader from '../../net/loader';
import { DRAW_LAYER_ORDER, STRATA_ORDER } from './order';
import { TemplateRegistry } from './templates';
import { parseToc } from './toc';
import { ParsedDocument, XmlElement, attr, parseXml } from './xml';

const GLUE = 'Interface\\GlueXML\\';

async function fetchText(path: string): Promise<string> {
  const bytes = await new Loader().load(path);
  return new TextDecoder('utf-8').decode(bytes);
}

async function loadDocument(file: string): Promise<ParsedDocument> {
  return parseXml(await fetchText(GLUE + file));
}

/** Count the top-level items by kind, which is the shape of a document at a glance. */
function summarise(doc: ParsedDocument): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of doc.items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  return counts;
}

export function installFramexmlDebug(): void {
  (window as never as Record<string, unknown>).framexml = {
    /** The real glue manifest, in load order. */
    async toc() {
      const toc = parseToc(await fetchText(GLUE + 'GlueXML.toc'));
      console.log(`${toc.files.length} files, ${toc.directives.length} directives`);
      console.table(toc.files.map((file, index) => ({ '#': index + 1, file })));
      return toc;
    },

    /** One document's top-level items, by kind and in order. */
    async xml(file = 'AccountLogin.xml') {
      const doc = await loadDocument(file);
      console.log(`${file}: ${doc.items.length} top-level items`, summarise(doc));
      if (doc.errors.length) {
        console.warn('parse errors:', doc.errors);
      }
      console.table(
        doc.items.map((item) => ({
          kind: item.kind,
          name: 'element' in item ? (attr(item.element, 'name') ?? '') : '',
          tag: 'element' in item ? item.element.tag : '',
          path: 'path' in item ? item.path : '',
        })),
      );
      return doc;
    },

    /**
     * Register every template the named documents declare, then expand one instance and report what
     * the merge produced.
     *
     * The registry is shared across the whole list on purpose -- that is the cross-document rule, and
     * `AccountLogin.xml` inheriting a template `GlueTemplates.xml` declared is exactly the case a
     * per-document registry would silently drop.
     */
    async templates(
      files = ['GlueButtons.xml', 'GlueTemplates.xml', 'GlueDialog.xml', 'AccountLogin.xml'],
      instanceName = 'AccountLoginLoginButton',
    ) {
      const registry = new TemplateRegistry();
      const warnings: string[] = [];
      let registered = 0;
      // The matched NODE, not the top-level item containing it. The interesting elements are nested:
      // `AccountLoginLoginButton` lives inside the `AccountLogin` ModelFFX, and expanding the ModelFFX
      // (which inherits nothing) reports a no-op merge that looks like the registry did not work.
      let target: XmlElement | null = null;

      for (const file of files) {
        const doc = await loadDocument(file);
        for (const item of doc.items) {
          if (item.kind === 'template') {
            registry.register(item.element);
            registered += 1;
          }
        }
        const walk = (node: XmlElement): void => {
          if (attr(node, 'name') === instanceName) {
            target = node;
          }
          node.children.forEach(walk);
        };
        doc.items.forEach((item) => {
          if ('element' in item) {
            walk(item.element);
          }
        });
      }

      console.log(`registered ${registered} templates from ${files.length} documents`);
      const found: XmlElement | null = target;
      if (!found) {
        console.warn(`no element named ${instanceName} in those documents`);
        return { registry, registered };
      }

      const expanded = registry.expand(found, warnings);

      // Flat lines and tables, not `console.log('text', obj)`. A collapsed object row is invisible
      // until you expand it and copies as nothing, which makes the most interesting output of this
      // whole module the one part you cannot paste into a bug report.
      console.log(
        `expanded <${found.tag} name="${instanceName}" inherits="${attr(found, 'inherits') ?? ''}">: ` +
          `${found.children.length} children -> ${expanded.children.length}`,
      );
      console.table(
        expanded.children.map((child, index) => ({
          '#': index,
          tag: child.tag,
          // Everything up to the instance's own children came from the template, and the boundary is
          // just the count the instance declared itself.
          from: index < expanded.children.length - found.children.length ? 'template' : 'own',
          name: attr(child, 'name') ?? '',
        })),
      );
      console.table(
        Array.from(expanded.attrs).map(([name, value]) => ({
          attr: name,
          value,
          // `virtual` and `name` splice through from the template like any other attribute -- see the
          // caveat on `merge`. An element that is not virtual in its own XML can come out marked so.
          note: attr(found, name) === undefined ? 'INHERITED from the template' : 'its own',
        })),
      );
      if (warnings.length) {
        console.warn('warnings:', warnings);
      }
      return { expanded, warnings };
    },

    help() {
      console.log('framexml.toc()                    the real glue manifest, in load order');
      console.log('framexml.xml("AccountLogin.xml")  one document, classified');
      console.log('framexml.templates()              register across files, expand one instance');
      console.log(`strata: ${STRATA_ORDER.join(' < ')}`);
      console.log(`layers: ${DRAW_LAYER_ORDER.join(' < ')}`);
    },
  };

  console.log('framexml debug ready -- framexml.help()');
}
