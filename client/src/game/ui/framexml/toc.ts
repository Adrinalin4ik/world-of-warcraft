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
