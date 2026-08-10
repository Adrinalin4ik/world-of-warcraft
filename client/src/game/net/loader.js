// Host serving loose, extracted 3.3.5a client files. Overridable so the app can be pointed at a
// local static directory or a different client build without a code change.
const DEFAULT_DATA_URI = 'https://data-direct.spelunkerdb.com/12340';

/**
 * Turn an MPQ-style path into one the asset host will serve: backslashes to forward slashes,
 * lowercased, surrounding whitespace dropped.
 *
 * This is not cosmetic. The host is case-sensitive and 404s on `DBFilesClient/Map.dbc` while serving
 * `dbfilesclient/map.dbc`. Paths reaching this loader come from parsed game files and from callers
 * that upper-case them, so normalizing here is what makes every other caller work unchanged.
 */
export const normalizePath = (path) => path.trim().toLowerCase().replace(/\\/g, '/');

/**
 * Clean the configured host prefix: surrounding whitespace off, trailing slashes off.
 *
 * Both halves are repairs of a real deployment. The prefix is typed by a person into a `.env` file or
 * a GitHub Actions repository variable, and a value saved with a trailing line break arrived here as
 * `https://host/12340\r\n`. `url()` below runs the whole string through `encodeURI`, which faithfully
 * encodes those two characters -- so every asset in the client was requested as
 * `/12340%0D%0A/textures/sunglare.blp` and every one of them 404'd. Nothing named the newline; the
 * URLs even look right in a log until something renders the control characters.
 *
 * Not lower-cased, unlike `normalizePath`: the host may be, but a path prefix is the operator's to
 * spell, and the case-sensitivity that forces `normalizePath`'s hand applies to what the game files
 * ask for, not to where the operator put them.
 */
export const normalizePrefix = (prefix) => String(prefix).trim().replace(/\/+$/, '');

class Loader {

  constructor() {
    this.prefix = this.prefix || process.env.REACT_APP_DATA_URI || DEFAULT_DATA_URI;
  }

  // Normalized here rather than in the constructor because `prefix` is a plain field: the constructor
  // itself reads an already-set `this.prefix` first, so a caller assigning one afterwards would walk
  // straight past a constructor-only repair. This is the one place every asset URL is built.
  url(path) {
    return encodeURI(`${normalizePrefix(this.prefix)}/${normalizePath(path)}`);
  }

  async load(path) {
    const uri = this.url(path);
    const response = await fetch(uri);

    // A missing asset returns an HTML error page, not an error status the caller would notice on
    // its own. Reject instead, or that markup gets handed to a binary decoder as if it were data.
    if (!response.ok) {
      throw new Error(`Failed to load asset (${response.status} ${response.statusText}): ${uri}`);
    }

    return response.arrayBuffer();
  }

}

export default Loader;
