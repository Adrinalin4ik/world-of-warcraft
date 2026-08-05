/** @jest-environment node */
import { DecodeStream } from 'restructure';

import { Camera } from '../index';

/**
 * One camera record laid out as a 3.3.5 (version 264) M2 stores it, decoded from byte 0.
 *
 * Record: type i32, fov f32, farClip f32, nearClip f32, position track (20 B), positionBase C3,
 * target track (20 B), targetBase C3, roll track (20 B) -> stride 0x64. The vanilla stride is 0x7c
 * because 1.12 tracks carry an extra `ranges` array; that is exactly what this test pins down.
 *
 * Camera track values are M2SplineKey triples (value, inTan, outTan), NOT bare vectors -- 36 bytes
 * per key for a C3. Reading them as bare vec3 would misalign every key after the first.
 */
function buildCamera() {
  const buffer = Buffer.alloc(0xa0);

  buffer.writeInt32LE(0, 0x00);        // type
  buffer.writeFloatLE(0.8, 0x04);      // fov (radians, DIAGONAL -- see scene-rig/glue-scene)
  buffer.writeFloatLE(500, 0x08);      // farClip
  buffer.writeFloatLE(0.5, 0x0c);      // nearClip

  buffer.writeUInt16LE(0, 0x10);       // positions: interpolationType
  buffer.writeInt16LE(-1, 0x12);       // positions: globalSequenceID
  buffer.writeUInt32LE(1, 0x14);       // 1 timestamp track
  buffer.writeUInt32LE(0x64, 0x18);    // ...at 0x64
  buffer.writeUInt32LE(1, 0x1c);       // 1 value track
  buffer.writeUInt32LE(0x70, 0x20);    // ...at 0x70

  buffer.writeFloatLE(1, 0x24);        // positionBase
  buffer.writeFloatLE(2, 0x28);
  buffer.writeFloatLE(3, 0x2c);

  // target track (0x30) and roll track (0x50) left as zero counts -- unkeyed, which is the common
  // authored case for a glue scene camera.

  buffer.writeFloatLE(4, 0x44);        // targetBase
  buffer.writeFloatLE(5, 0x48);
  buffer.writeFloatLE(6, 0x4c);

  buffer.writeUInt32LE(1, 0x64);       // timestamp track 0: 1 key
  buffer.writeUInt32LE(0x6c, 0x68);    // ...at 0x6c
  buffer.writeUInt32LE(0, 0x6c);       // t = 0

  buffer.writeUInt32LE(1, 0x70);       // value track 0: 1 key
  buffer.writeUInt32LE(0x78, 0x74);    // ...at 0x78
  buffer.writeFloatLE(0.5, 0x78);      // spline key: value.x
  buffer.writeFloatLE(0, 0x7c);        // value.y
  buffer.writeFloatLE(0, 0x80);        // value.z
  // inTan (0x84) and outTan (0x90) stay zero

  return buffer;
}

describe('M2 Camera', () => {
  it('decodes the authored framing fields', () => {
    const camera = Camera.decode(new DecodeStream(buildCamera()));

    expect(camera.fov).toBeCloseTo(0.8);
    expect(camera.farClip).toBeCloseTo(500);
    expect(camera.nearClip).toBeCloseTo(0.5);
    expect(Array.from(camera.positionBase)).toEqual([1, 2, 3]);
    expect(Array.from(camera.targetBase)).toEqual([4, 5, 6]);
  });

  it('decodes position keys as spline-key triples', () => {
    const camera = Camera.decode(new DecodeStream(buildCamera()));
    const key = camera.positions.tracks[0].values[0];

    expect(Array.from(key.value)).toEqual([0.5, 0, 0]);
    expect(Array.from(key.inTan)).toEqual([0, 0, 0]);
  });

  it('consumes exactly the 3.3.5 record stride', () => {
    const stream = new DecodeStream(buildCamera());
    Camera.decode(stream);

    // 0x64, not vanilla's 0x7c. A wrong stride shifts every camera after the first.
    expect(stream.pos).toBe(0x64);
  });
});
