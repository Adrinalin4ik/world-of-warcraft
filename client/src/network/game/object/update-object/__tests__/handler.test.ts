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
import Packet from '../../../../net/packet';
import { UpdateFlags } from '../../enums';
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

  /**
   * A FALLING unit's movement block, then its update-mask block, read back off one buffer.
   *
   * This is the regression test for `RangeError: Invalid array length at parseUpdateValues`, and it is
   * deliberately shaped as a CURSOR test rather than an assertion about `parseUpdateValues` alone.
   * The RangeError was never a bug in the mask code: `parseMovement` wrote `packet.readByte(16)`-style
   * skips whose argument byte-buffer reads as the BYTE ORDER, so a falling unit's four jump floats
   * consumed 4 bytes of their 16, and `parseUpdateValues` then read its block count out of the middle
   * of the previous field. Asserting on the FIELD VALUE that follows the movement block is what pins
   * that: it can only come out right if every byte before it was consumed.
   *
   * Happy path, one packet, no mocks -- the bytes are laid out the way TrinityCore 3.3.5a's
   * `Object::BuildMovementUpdate` writes them.
   */
  it('reads a falling unit\'s movement block at full width, so the mask that follows lands', () => {
    const handler = new UpdateObjectHandler({ on: jest.fn() } as never);

    const MOVEFLAG_FALLING = 0x00001000;

    // Laid out with a DataView rather than a ByteBuffer: writing the bytes by hand is the point --
    // a helper that shared the reader's own idea of a field width could not catch a width bug.
    const raw = new Uint8Array(128);
    const view = new DataView(raw.buffer);
    let at = 0;
    const u16 = (v: number) => { view.setUint16(at, v, true); at += 2; };
    const u32 = (v: number) => { view.setUint32(at, v, true); at += 4; };
    const u8 = (v: number) => { view.setUint8(at, v); at += 1; };
    const f32 = (v: number) => { view.setFloat32(at, v, true); at += 4; };

    u16(UpdateFlags.UPDATEFLAG_LIVING);
    u32(MOVEFLAG_FALLING); // movement flags
    u16(0); // extra movement flags
    u32(12345); // timestamp
    [-8952.5, -129.8, 83.24, 1.5].forEach(f32); // x, y, z, facing
    u32(700); // fall time
    // The four jump floats -- 16 bytes. Each of these was being read as ONE byte.
    [-7.9556, 0.5, 0.8660254, 4.5].forEach(f32);
    // Nine speeds: walk, run, runBack, swim, swimBack, fly, flyBack, turn, pitch.
    [2.5, 7, 4.5, 4.72, 2.5, 7, 4.5, 3.14159, 3.14159].forEach(f32);

    // Then the update-mask block: one 32-bit block with bit 0 set, and its one uint32 value.
    u8(1);
    u32(1);
    u32(0xdecaf);

    const packet = new Packet(0x00a9, raw.subarray(0, at), false);
    const movement = handler.parseMovement(packet);

    expect(movement.fallTime).toBe(700);
    expect(movement.fallVelocity).toBeCloseTo(-7.9556, 3);
    expect(movement.runSpeed).toBeCloseTo(7, 3);
    // The payload after the movement block. Wrong only if the cursor is wrong.
    expect(handler.parseUpdateValues(packet)[0]).toBe(0xdecaf);
  });
});
