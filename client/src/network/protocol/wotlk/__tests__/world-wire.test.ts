/** @jest-environment node */
import {
  CHAR_RESULT,
  charCreateRefusal,
  decodeCharEnum,
  encodeCharCreateBody,
  encodeGuidBody,
} from '../world-wire';

/**
 * A char-enum body, laid out as 3.3.5 sends it: count, then per character guid(8), name cstring,
 * race, class, gender, appearance u32, facial hair, level, zone u32, map u32, x/y/z f32, guild u32,
 * flags u32, customization u32, first-login u8, pet display/level/family u32, then 23 equipment
 * slots of display u32 + inventory type u8 + enchantment u32.
 */
function buildCharEnum(): Uint8Array {
  const parts: number[] = [];
  const push = (...values: number[]) => parts.push(...values);
  const pushU32 = (value: number) =>
    push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  const pushF32 = (value: number) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let i = 0; i < 4; ++i) push(view.getUint8(i));
  };
  const pushString = (text: string) => {
    for (const char of text) push(char.charCodeAt(0));
    push(0);
  };
  const pushCharacter = (name: string, petDisplay: number) => {
    push(1, 0, 0, 0, 0, 0, 0, 0); // guid low byte 1
    pushString(name);
    push(1); // race: human
    push(2); // class: paladin
    push(0); // gender: male
    // appearance u32: skin 3, face 4, hair style 5, hair colour 6
    pushU32(3 | (4 << 8) | (5 << 16) | (6 << 24));
    push(7); // facial hair
    push(80); // level
    pushU32(12); // zone
    pushU32(0); // map
    pushF32(-8949.95);
    pushF32(-132.49);
    pushF32(83.53);
    pushU32(0); // guild
    pushU32(0); // flags
    pushU32(0); // customization flags
    push(0); // first login
    pushU32(petDisplay);
    pushU32(petDisplay ? 70 : 0);
    pushU32(petDisplay ? 1 : 0);
    for (let slot = 0; slot < 23; ++slot) {
      pushU32(slot === 0 ? 1234 : 0); // display id
      push(slot === 0 ? 4 : 0); // inventory type
      pushU32(0); // enchantment
    }
  };

  push(2); // two characters
  pushCharacter('Arthas', 0);
  pushCharacter('Jaina', 4567);

  return new Uint8Array(parts);
}

describe('decodeCharEnum', () => {
  // Decoded once here rather than at describe-body level: a throw in the body fails the whole file
  // with a confusing message instead of failing one test.
  let characters: ReturnType<typeof decodeCharEnum>;

  beforeAll(() => {
    characters = decodeCharEnum(buildCharEnum());
  });

  it('reads both characters', () => {
    expect(characters.map((character) => character.name)).toEqual(['Arthas', 'Jaina']);
  });

  it('unpacks the appearance dials out of the packed u32', () => {
    expect(characters[0].appearance).toEqual({
      skin: 3,
      face: 4,
      hairStyle: 5,
      hairColor: 6,
      facialHair: 7,
    });
  });

  it('keeps the guid as a string rather than a lossy number', () => {
    expect(typeof characters[0].guid).toBe('string');
    expect(characters[0].guid).toMatch(/^0x[0-9a-f]+$/);
  });

  it('reads the position and level', () => {
    expect(characters[0].level).toBe(80);
    expect(characters[0].position[0]).toBeCloseTo(-8949.95, 1);
  });

  it('reports equipment as a list, and its populated slots', () => {
    expect(characters[0].equipment).toHaveLength(23);
    expect(characters[0].equipment[0]).toEqual({
      displayId: 1234,
      inventoryType: 4,
      enchantmentId: 0,
    });
  });

  it('omits the pet entirely when there is none, and reports one when there is', () => {
    expect(characters[0].pet).toBeUndefined();
    expect(characters[1].pet).toEqual({ displayId: 4567, level: 70, family: 1 });
  });
});

describe('encodeCharCreateBody', () => {
  it('terminates the name with NUL, not a space -- space is indistinguishable from a name character', () => {
    const bytes = encodeCharCreateBody({
      name: 'Newbie',
      race: 4,
      class: 3,
      gender: 1,
      appearance: { skin: 5, face: 6, hairStyle: 7, hairColor: 8, facialHair: 9 },
      outfitId: 0,
    });

    // Verify the name bytes
    const nameBytes = Array.from(bytes.slice(0, 6));
    expect(nameBytes).toEqual([78, 101, 119, 98, 105, 101]); // 'Newbie' in ASCII

    // Verify the NUL terminator at position 6
    expect(bytes[6]).toBe(0);

    // Verify the remaining fields follow immediately after the terminator
    expect(Array.from(bytes.slice(7))).toEqual([4, 3, 1, 5, 6, 7, 8, 9, 0]);
  });
});

describe('encodeGuidBody', () => {
  it('writes a guid as eight little-endian bytes -- delete and player-login share this body', () => {
    expect(Array.from(encodeGuidBody('0x1'))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('encodes a realistic 64-bit player guid without losing the high half -- cannot use Number()', () => {
    // A realistic guid beyond safe integer range: 0x123456789ABCDEF0
    // Low: 0x9ABCDEF0, High: 0x12345678
    // Parsing as Number(guid) loses precision beyond 2^53-1; this guid is 1.3e18
    const bytes = encodeGuidBody('0x123456789ABCDEF0');
    // Little-endian low half: 0x9ABCDEF0
    const lowBytes = [0xF0, 0xDE, 0xBC, 0x9A];
    // Little-endian high half: 0x12345678
    const highBytes = [0x78, 0x56, 0x34, 0x12];
    expect(Array.from(bytes)).toEqual([...lowBytes, ...highBytes]);
  });
});

describe('charCreateRefusal', () => {
  it("names a refusal with the client's own key", () => {
    expect(charCreateRefusal(0x31)).toEqual({ code: 0x31, stringKey: 'CHAR_CREATE_NAME_IN_USE' });
  });

  it('falls back visibly for an unmapped code', () => {
    expect(charCreateRefusal(0x99).stringKey).toBe('CHAR_CREATE_ERROR');
  });

  it('knows which byte means success', () => {
    expect(CHAR_RESULT.CREATE_SUCCESS).toBe(0x2e);
  });
});
