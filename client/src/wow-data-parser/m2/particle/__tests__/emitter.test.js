/**
 * @jest-environment node
 */
import { DecodeStream } from 'restructure';

import M2 from '../../index';
import ParticleEmitter, { PARTICLE_EMITTER_SIZE, EMITTER_TYPE } from '../emitter';
const { fetchFixture } = require('./fixtures');

const MODELS = [
  'WORLD\\GENERIC\\PASSIVEDOODADS\\PARTICLEEMITTERS\\LAVASPLASHPARTICLE.M2',
  'WORLD\\GENERIC\\PASSIVEDOODADS\\PARTICLEEMITTERS\\LAVASMOKEEMITTERB.M2'
];

describe('ParticleEmitter struct', () => {
  it('consumes exactly 476 bytes, the WotLK M2Particle size', () => {
    const buffer = Buffer.alloc(PARTICLE_EMITTER_SIZE * 2);
    const stream = new DecodeStream(buffer);

    ParticleEmitter.decode(stream);

    expect(stream.pos).toBe(PARTICLE_EMITTER_SIZE);
    expect(PARTICLE_EMITTER_SIZE).toBe(476);
  });

  it('reads the scalar fields at their documented offsets', () => {
    const buffer = Buffer.alloc(PARTICLE_EMITTER_SIZE);

    buffer.writeUInt32LE(0xFFFFFFFF, 0x00);   // particleId
    buffer.writeUInt32LE(0x00001000, 0x04);   // flags
    buffer.writeUInt16LE(7, 0x14);            // boneId
    buffer.writeUInt16LE(3, 0x16);            // textureId
    buffer.writeUInt8(4, 0x28);               // blendingType
    buffer.writeUInt8(EMITTER_TYPE.SPHERE, 0x29);
    buffer.writeUInt16LE(11, 0x2a);           // particleColorIndex
    buffer.writeUInt8(1, 0x2c);               // particleType
    buffer.writeUInt8(2, 0x2d);               // headOrTail

    const emitter = ParticleEmitter.decode(new DecodeStream(buffer));

    expect(emitter.boneId).toBe(7);
    expect(emitter.textureId).toBe(3);
    expect(emitter.blendingType).toBe(4);
    expect(emitter.emitterType).toBe(EMITTER_TYPE.SPHERE);
    expect(emitter.particleColorIndex).toBe(11);
    expect(emitter.particleType).toBe(1);
    expect(emitter.headOrTail).toBe(2);
  });
});

describe('real emitter models', () => {
  MODELS.forEach((model) => {
    it(`decodes plausible emitters from ${model}`, async () => {
      const buffer = await fetchFixture(model);

      if (!buffer) {
        console.warn(`Skipping ${model}: asset host unreachable`);
        return;
      }

      const data = M2.decode(new DecodeStream(buffer));

      expect(Array.isArray(data.particleEmitters)).toBe(true);
      expect(data.particleEmitters.length).toBeGreaterThan(0);

      const validTypes = Object.values(EMITTER_TYPE);

      data.particleEmitters.forEach((emitter) => {
        // A misaligned struct almost never yields a valid enum, so this is the strongest single check.
        expect(validTypes).toContain(emitter.emitterType);

        expect(emitter.textureId).toBeLessThan(data.textures.length);
        expect(emitter.rows).toBeGreaterThanOrEqual(1);
        expect(emitter.columns).toBeGreaterThanOrEqual(1);

        const lifespans = emitter.lifespan.tracks
          .flatMap((track) => track.values);

        lifespans.forEach((lifespan) => {
          expect(lifespan).toBeGreaterThan(0);
          expect(lifespan).toBeLessThan(60);
        });
      });
    });
  });
});
