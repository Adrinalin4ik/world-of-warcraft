/** @jest-environment node */
import { DecodeStream } from 'restructure';

import { Attachment, Light } from '../index';

/**
 * A 3.3.5 light record: type u16, bone i16, position C3, then SEVEN 20-byte tracks -- ambient
 * colour/intensity, diffuse colour/intensity, attenuation start/end, visibility. Stride 0x9c.
 * (Vanilla's is 0xd4 because its tracks are 0x1c.)
 */
function buildLight() {
  const buffer = Buffer.alloc(0x100);

  buffer.writeUInt16LE(1, 0x00);   // type: 1 = point (the hot-spot caster)
  buffer.writeInt16LE(-1, 0x02);   // bone: -1 = model origin
  buffer.writeFloatLE(7, 0x04);    // position
  buffer.writeFloatLE(8, 0x08);
  buffer.writeFloatLE(9, 0x0c);

  // diffuse colour track lives at 0x10 + 2 * 20 = 0x38. One key, one vec3.
  buffer.writeUInt16LE(0, 0x38);
  buffer.writeInt16LE(-1, 0x3a);
  buffer.writeUInt32LE(1, 0x3c);      // 1 timestamp track
  buffer.writeUInt32LE(0xa0, 0x40);
  buffer.writeUInt32LE(1, 0x44);      // 1 value track
  buffer.writeUInt32LE(0xb0, 0x48);

  buffer.writeUInt32LE(1, 0xa0);      // timestamps: 1 key
  buffer.writeUInt32LE(0xa8, 0xa4);
  buffer.writeUInt32LE(0, 0xa8);

  buffer.writeUInt32LE(1, 0xb0);      // values: 1 key
  buffer.writeUInt32LE(0xb8, 0xb4);
  buffer.writeFloatLE(1.0, 0xb8);     // warm orange
  buffer.writeFloatLE(0.6, 0xbc);
  buffer.writeFloatLE(0.2, 0xc0);

  return buffer;
}

/** A 3.3.5 attachment: id u32, bone u16, unknown u16, position C3, one 20-byte track. Stride 40. */
function buildAttachment() {
  const buffer = Buffer.alloc(0x40);

  buffer.writeUInt32LE(0, 0x00);   // id 0 -- the glue stage spot
  buffer.writeUInt16LE(3, 0x04);   // bone
  buffer.writeUInt16LE(0, 0x06);
  buffer.writeFloatLE(-1.5, 0x08); // position
  buffer.writeFloatLE(0.25, 0x0c);
  buffer.writeFloatLE(2, 0x10);

  return buffer;
}

describe('M2 Light', () => {
  it('decodes type, bone and position', () => {
    const light = Light.decode(new DecodeStream(buildLight()));

    expect(light.type).toBe(1);
    expect(light.bone).toBe(-1);
    expect(Array.from(light.position)).toEqual([7, 8, 9]);
  });

  it('decodes the diffuse colour track', () => {
    const light = Light.decode(new DecodeStream(buildLight()));
    const key = light.diffuseColor.firstKeyframe;

    expect(Array.from(key.value)).toEqual([1, 0.6000000238418579, 0.20000000298023224]);
  });

  it('consumes exactly the 3.3.5 record stride', () => {
    const stream = new DecodeStream(buildLight());
    Light.decode(stream);

    expect(stream.pos).toBe(0x9c);
  });
});

describe('M2 Attachment', () => {
  it('decodes id, bone and model-space position', () => {
    const attachment = Attachment.decode(new DecodeStream(buildAttachment()));

    expect(attachment.id).toBe(0);
    expect(attachment.bone).toBe(3);
    expect(Array.from(attachment.position)).toEqual([-1.5, 0.25, 2]);
  });

  it('consumes exactly the 3.3.5 record stride', () => {
    const stream = new DecodeStream(buildAttachment());
    Attachment.decode(stream);

    expect(stream.pos).toBe(40);
  });
});
