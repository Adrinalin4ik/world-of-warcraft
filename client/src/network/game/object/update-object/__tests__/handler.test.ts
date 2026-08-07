/**
 * `SMSG_COMPRESSED_UPDATE_OBJECT` actually decompresses.
 *
 * The one test worth having here, because the defect it pins was invisible to every other kind of
 * check: `zlib-browserify`'s `inflate` takes `(input, callback, options)` (its bundled `zlib.js:52` is
 * `function wb(b,a,c){process.nextTick(function(){ ... a(d,f) })}`), not node's
 * `(input, options, callback)`. Called node-style, the empty options object was invoked as the
 * callback, every compressed update threw `a is not a function` inside `process.nextTick` -- a window
 * error with no stack into this file -- and not one object was ever created. Measured on a live world
 * entry: 38 compressed updates, 38 throws, while the uncompressed `SMSG_UPDATE_OBJECT` path worked
 * throughout, which is why the handler looked correctly wired.
 *
 * So this is a ROUND TRIP through the real library rather than an assertion about argument positions:
 * a mock that recorded the call shape would have been written to match whichever order the code used.
 */
import zlib from 'zlib-browserify';
import { UpdateObjectHandler } from '../handler';

/** The 4-byte incoming header, then the u32 uncompressed length -- what `raw.slice(8)` skips. */
const PREAMBLE = 8;

describe('UpdateObjectHandler', () => {
  it('inflates a compressed update and hands the plain body on', async () => {
    const handler = new UpdateObjectHandler({ on: jest.fn() } as never);

    // `count = 0`: a well-formed update-object body with no blocks in it. The point is that the
    // callback fires with real inflated bytes, not that any particular object is parsed -- every
    // update type has its own wire format and this test is about the transport, not the parser.
    const body = Buffer.from([0, 0, 0, 0]);
    const deflated: Uint8Array = await new Promise((resolve, reject) =>
      zlib.deflate(body, (error: any, result: any) => (error ? reject(error) : resolve(result))),
    );

    // Assembled by hand rather than with `Buffer.concat`: node's `Buffer` types no longer satisfy
    // `Uint8Array<ArrayBuffer>` (its backing buffer is `ArrayBufferLike`), and `tsc` rejects the
    // concat even though jest is perfectly happy with it.
    const raw = new Uint8Array(PREAMBLE + deflated.length);
    raw.set(deflated, PREAMBLE);
    const seen: number[] = [];
    jest
      .spyOn(handler, 'handleUpdateObjectPacket')
      .mockImplementation((packet: any) => seen.push(packet.readUnsignedInt()));

    // Only the three members `handleCompressedUpdateObjectPacket` reads off the packet.
    const packet = { readInt: () => body.length, readByte: () => 0, raw } as never;
    await handler.handleCompressedUpdateObjectPacket(packet);
    // `inflate` defers through `process.nextTick`, so the callback has not run yet. A macrotask turn
    // drains it (`setImmediate` is not defined under this project's jsdom test environment).
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler.handleUpdateObjectPacket).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([0]);
  });
});
