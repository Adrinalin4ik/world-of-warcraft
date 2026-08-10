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

class Loader {

  constructor() {
    this.prefix = this.prefix || process.env.REACT_APP_DATA_URI || DEFAULT_DATA_URI;
  }

  url(path) {
    return encodeURI(`${this.prefix}/${normalizePath(path)}`);
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
