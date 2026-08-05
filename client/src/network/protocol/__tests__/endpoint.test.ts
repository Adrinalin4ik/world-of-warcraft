import { resolveRealmEndpoint } from '../endpoint';

const REALM = {
  id: 1,
  name: 'Blackrock',
  host: '95.181.139.52',
  port: 8086,
  population: 1,
  characterCount: 0,
  online: true,
  recommended: false,
  pvp: false,
};

describe('resolveRealmEndpoint', () => {
  it('keeps the realm port and substitutes the proxy host', () => {
    // A browser cannot open a raw TCP socket: the realm's advertised address has no WebSocket
    // listener, and `client/websockify.js` is what bridges the two. This is the convention the
    // existing client relies on silently -- `realms.tsx` passes the AUTH host with the realm.
    expect(resolveRealmEndpoint(REALM, { proxyHost: 'localhost', rewriteRealmHost: true })).toEqual({
      host: 'localhost',
      port: 8086,
    });
  });

  it('honours the realm address as advertised when told to', () => {
    // A deployment that terminates WebSockets at the realm itself needs no rewriting.
    expect(resolveRealmEndpoint(REALM, { proxyHost: 'localhost', rewriteRealmHost: false })).toEqual({
      host: '95.181.139.52',
      port: 8086,
    });
  });
});
