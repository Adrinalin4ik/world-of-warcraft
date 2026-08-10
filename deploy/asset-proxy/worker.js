/**
 * A CORS-adding mirror of the loose-file game data host, for deployments that are not
 * `http://localhost:3000`.
 *
 * Why this exists, measured against the live host on 2026-08-10:
 *
 *   GET /12340/dbfilesclient/map.dbc   Origin: http://localhost:3000
 *     -> 200, Vary: Origin, Access-Control-Allow-Origin: http://localhost:3000
 *   GET /12340/dbfilesclient/map.dbc   Origin: https://<owner>.github.io
 *     -> 200, and NO Access-Control-Allow-Origin at all
 *   OPTIONS /12340/dbfilesclient/map.dbc  (preflight)
 *     -> 403
 *
 * The bytes are served either way; it is the browser that discards them. So a page served from any
 * origin but `localhost:3000` -- GitHub Pages included -- boots, draws its login screen out of its
 * own bundle, and then loads no terrain, no doodads, no models and no DBCs, with nothing on screen
 * explaining the silence. This worker sits in front of the same host and answers with the one header
 * the browser is waiting for.
 *
 * It is a pass-through, not a cache of its own: same paths, same bytes, same status codes. Point the
 * client at it with the `REACT_APP_DATA_URI` build variable (see `deploy/asset-proxy/README.md`), and
 * note that the value must include the build sub-path -- `https://<worker-host>/12340`.
 */

/** The host being mirrored. Overridable per deployment via a wrangler var. */
const DEFAULT_UPSTREAM = 'https://data-direct.spelunkerdb.com';

/**
 * Which page origins this proxy answers for, comma-separated, or `*` for any.
 *
 * Defaulting to `*` would be the convenient choice and is the wrong one: an open proxy in front of
 * someone else's bandwidth is a thing other sites can point at. So the default is empty and every
 * deployment states its own origins.
 */
const DEFAULT_ALLOWED_ORIGINS = '';

/** Only reads are mirrored -- the upstream is a static file host and nothing here should write. */
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

/**
 * Headers a caller may send. `Range` is the one that matters: it is not a CORS-safelisted request
 * header, so a ranged read triggers a preflight, and the upstream answers preflights with 403.
 */
const ALLOWED_REQUEST_HEADERS = 'Range, If-None-Match, If-Modified-Since';

/**
 * Response headers the page is allowed to READ. Without this list a cross-origin caller sees only
 * the safelisted few, so `Content-Range` and `Content-Length` would be invisible to any code that
 * reads sizes back -- present on the wire and absent from `response.headers`.
 */
const EXPOSED_RESPONSE_HEADERS = 'Content-Length, Content-Range, Content-Type, Accept-Ranges, ETag, Last-Modified';

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The `Access-Control-Allow-Origin` value for this caller, or null to send none.
 *
 * The allowlisted origin is echoed back rather than answered with `*` so that the header stays
 * correct if credentialed requests are ever used, and `Vary: Origin` accompanies it at every call
 * site -- without it a shared cache can hand one origin's ACAO to another and the failure appears
 * only for the second visitor.
 */
function resolveAllowOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) {
    // Not a browser cross-origin request (curl, a health check). Nothing to authorise.
    return null;
  }

  const allowed = allowedOrigins(env);
  if (allowed.includes('*')) {
    return '*';
  }
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(allowOrigin) {
  const headers = new Headers({ Vary: 'Origin' });
  if (allowOrigin) {
    headers.set('Access-Control-Allow-Origin', allowOrigin);
    headers.set('Access-Control-Expose-Headers', EXPOSED_RESPONSE_HEADERS);
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const allowOrigin = resolveAllowOrigin(request, env);

    if (request.method === 'OPTIONS') {
      // Answer the preflight the upstream 403s. A disallowed origin still gets a 204 -- with no
      // allow headers on it, which is what makes the browser refuse the real request.
      const headers = corsHeaders(allowOrigin);
      if (allowOrigin) {
        headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
        headers.set('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
        headers.set('Access-Control-Max-Age', '86400');
      }
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Only GET, HEAD and OPTIONS are mirrored.', {
        status: 405,
        headers: corsHeaders(allowOrigin),
      });
    }

    if (request.headers.get('Origin') && !allowOrigin) {
      // Refuse in the open rather than serving bytes the browser will silently drop: a 403 with a
      // reason is debuggable, a 200 missing one header looks like a broken client.
      return new Response(
        'This asset proxy does not serve that origin. Add it to ALLOWED_ORIGINS in wrangler.toml.',
        { status: 403, headers: corsHeaders(null) },
      );
    }

    const incoming = new URL(request.url);
    const upstream = new URL(env.UPSTREAM ?? DEFAULT_UPSTREAM);
    // Path and query are carried across untouched. The upstream is case-sensitive and the client
    // already lower-cases what it asks for (`client/src/game/net/loader.js:13`), so any rewriting
    // here could only break a path that was correct.
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;

    const response = await fetch(upstream, {
      method: request.method,
      headers: forwardedRequestHeaders(request),
      redirect: 'follow',
    });

    // The upstream's own headers are kept -- status, Content-Type, ETag, Last-Modified,
    // Accept-Ranges -- so conditional and ranged reads keep working through the mirror.
    const headers = new Headers(response.headers);
    for (const [name, value] of corsHeaders(allowOrigin)) {
      headers.set(name, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

/**
 * The subset of the caller's headers that goes upstream.
 *
 * Deliberately not the whole request: `Origin` and `Referer` would reach a host that treats one
 * origin specially, and a forwarded `Accept-Encoding` invites a double-encoded body. The
 * `User-Agent` is set explicitly because the upstream rejects some of them, so leaving it to
 * whatever the runtime defaults to is a failure waiting for a runtime upgrade.
 */
function forwardedRequestHeaders(request) {
  const headers = new Headers({
    'User-Agent': 'Mozilla/5.0 (compatible; browser-wow-asset-proxy)',
    Accept: request.headers.get('Accept') ?? '*/*',
  });

  for (const name of ['Range', 'If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
}
