/**
 * GlueStrings: the client's own UI text.
 *
 * No screen in this subsystem may hardcode a user-visible string. Everything the player reads comes
 * from `interface/gluexml/gluestrings.lua` -- including error text, so a server result code shows
 * the client's own wording (`AUTH_*`, `CHAR_CREATE_*`) rather than ours.
 */
import Loader from '../net/loader';

const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;?/;

const ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, char) => ESCAPES[char] ?? char);
}

/** Parse the shipped Lua string table. Anything that is not a `KEY = "value"` line is ignored. */
export function parseGlueStrings(source: string): Map<string, string> {
  const table = new Map<string, string>();

  for (const line of source.split('\n')) {
    const match = ASSIGNMENT.exec(line);
    if (match) {
      table.set(match[1], unescape(match[2]));
    }
  }

  return table;
}

export class GlueStrings {
  private readonly table: Map<string, string>;

  constructor(table: Map<string, string>) {
    this.table = table;
  }

  static async load(): Promise<GlueStrings> {
    const raw = await new Loader().load('Interface\\GlueXML\\GlueStrings.lua');
    const source = new TextDecoder('utf-8').decode(raw);
    return new GlueStrings(parseGlueStrings(source));
  }

  has(key: string): boolean {
    return this.table.has(key);
  }

  /** The string, or the key itself when absent -- a missing string must be VISIBLE, not blank. */
  get(key: string): string {
    return this.table.get(key) ?? key;
  }

  /** Substitute `%s`/`%d` placeholders positionally, as the client's `format` does. */
  format(key: string, ...args: Array<string | number>): string {
    let index = 0;
    return this.get(key).replace(/%[sd]/g, () => String(args[index++] ?? ''));
  }
}
