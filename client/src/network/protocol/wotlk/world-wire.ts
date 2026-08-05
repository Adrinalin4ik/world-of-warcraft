/**
 * The world server's character-management wire format for 3.3.5a, as pure functions over bytes.
 *
 * The char-enum layout mirrors the working parse in `network/characters/handler.js`; create and
 * delete are new. Bodies only -- the opcode and the encrypted header are the transport's business.
 */
import { CharacterRecord, CharCreateRequest, EquipmentDisplay, ProtocolRefusal } from '../types';

/** Equipment slots a 3.3.5 roster enumerates. Vanilla sends fewer; consumers read the list length. */
const EQUIPMENT_SLOTS = 23;

export const CHAR_RESULT = {
  CREATE_SUCCESS: 0x2e,
  DELETE_SUCCESS: 0x3a,
} as const;

/**
 * PROVISIONAL. The key names are verified in the shipped `gluestrings.lua`; the numeric codes follow
 * the WotLK `ResponseCodes` ordering (corroborated at `AUTH_OK = 0x0c` by the two codes the existing
 * client already acts on) but are not verifiable from anything in this repository. A live server
 * confirms or corrects them; they are isolated here so that correction is a one-file edit.
 */
export const CHAR_CREATE_STRINGS: Record<number, string> = {
  0x2d: 'CHAR_CREATE_IN_PROGRESS',
  0x2e: 'CHAR_CREATE_SUCCESS',
  0x2f: 'CHAR_CREATE_ERROR',
  0x30: 'CHAR_CREATE_FAILED',
  0x31: 'CHAR_CREATE_NAME_IN_USE',
  0x32: 'CHAR_CREATE_DISABLED',
  0x33: 'CHAR_CREATE_PVP_TEAMS_VIOLATION',
  0x34: 'CHAR_CREATE_SERVER_LIMIT',
  0x35: 'CHAR_CREATE_ACCOUNT_LIMIT',
  0x36: 'CHAR_CREATE_SERVER_QUEUE',
  0x37: 'CHAR_CREATE_ONLY_EXISTING',
  0x38: 'CHAR_CREATE_EXPANSION',
};

export const CHAR_DELETE_STRINGS: Record<number, string> = {
  0x39: 'CHAR_DELETE_IN_PROGRESS',
  0x3a: 'CHAR_DELETE_SUCCESS',
  0x3b: 'CHAR_DELETE_FAILED',
  0x3c: 'CHAR_DELETE_FAILED_LOCKED_FOR_TRANSFER',
};

export function charCreateRefusal(code: number): ProtocolRefusal {
  return { code, stringKey: CHAR_CREATE_STRINGS[code] ?? 'CHAR_CREATE_ERROR' };
}

export function charDeleteRefusal(code: number): ProtocolRefusal {
  return { code, stringKey: CHAR_DELETE_STRINGS[code] ?? 'CHAR_DELETE_FAILED' };
}

/** Both `SMSG_CHAR_CREATE` and `SMSG_CHAR_DELETE` are a single result byte. */
export function decodeResultByte(bytes: Uint8Array): number {
  return bytes[0];
}

export function decodeCharEnum(bytes: Uint8Array): CharacterRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;

  const u8 = (): number => bytes[at++];
  const u32 = (): number => {
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const f32 = (): number => {
    const value = view.getFloat32(at, true);
    at += 4;
    return value;
  };
  const guid = (): string => {
    // Little-endian 64-bit. Kept as a hex string: a guid does not survive a JS number.
    let hex = '';
    for (let i = 7; i >= 0; --i) {
      hex += bytes[at + i].toString(16).padStart(2, '0');
    }
    at += 8;
    return `0x${hex.replace(/^0+(?=.)/, '')}`;
  };
  const cstring = (): string => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) {
      ++end;
    }
    const text = new TextDecoder('latin1').decode(bytes.slice(at, end));
    at = end + 1;
    return text;
  };

  const count = u8();
  const characters: CharacterRecord[] = [];

  for (let index = 0; index < count; ++index) {
    const record: CharacterRecord = {
      guid: guid(),
      name: cstring(),
      race: u8(),
      class: u8(),
      gender: u8(),
      appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
      level: 0,
      zoneId: 0,
      mapId: 0,
      position: [0, 0, 0],
      guildId: 0,
      flags: 0,
      equipment: [],
    };

    const packed = u32();
    record.appearance = {
      skin: packed & 0xff,
      face: (packed >> 8) & 0xff,
      hairStyle: (packed >> 16) & 0xff,
      hairColor: (packed >> 24) & 0xff,
      facialHair: u8(),
    };

    record.level = u8();
    record.zoneId = u32();
    record.mapId = u32();
    record.position = [f32(), f32(), f32()];
    record.guildId = u32();
    record.flags = u32();

    u32(); // customization flags
    u8(); // first login

    const petDisplayId = u32();
    const petLevel = u32();
    const petFamily = u32();
    if (petDisplayId) {
      record.pet = { displayId: petDisplayId, level: petLevel, family: petFamily };
    }

    const equipment: EquipmentDisplay[] = [];
    for (let slot = 0; slot < EQUIPMENT_SLOTS; ++slot) {
      equipment.push({ displayId: u32(), inventoryType: u8(), enchantmentId: u32() });
    }
    record.equipment = equipment;

    characters.push(record);
  }

  return characters;
}

export function encodeCharCreateBody(request: CharCreateRequest): Uint8Array {
  const name = Array.from(request.name).map((char) => char.charCodeAt(0));

  return new Uint8Array([
    ...name,
    0, // NUL terminator (cstring format)
    request.race,
    request.class,
    request.gender,
    request.appearance.skin,
    request.appearance.face,
    request.appearance.hairStyle,
    request.appearance.hairColor,
    request.appearance.facialHair,
    request.outfitId,
  ]);
}

/** The 8-byte little-endian guid body. `CMSG_CHAR_DELETE` and `CMSG_PLAYER_LOGIN` are both just this. */
export function encodeGuidBody(guid: string): Uint8Array {
  // Parse as two 32-bit halves (low, high) rather than BigInt, for ES6 target compatibility
  // and parity with GUID.raw and the existing packet layer (client/src/network/game/guid.ts).
  // A 64-bit value does not survive conversion to JS Number, which is why the guid string exists.
  let hex = guid.startsWith('0x') ? guid.slice(2) : guid;
  hex = hex.padStart(16, '0'); // Pad to 16 hex digits (8 bytes, 64 bits)

  const highHex = hex.slice(0, 8); // High 32 bits
  const lowHex = hex.slice(8, 16); // Low 32 bits

  const low = parseInt(lowHex, 16);
  const high = parseInt(highHex, 16);

  const out = new Uint8Array(8);
  // Write low 32-bit half (little-endian)
  out[0] = low & 0xff;
  out[1] = (low >> 8) & 0xff;
  out[2] = (low >> 16) & 0xff;
  out[3] = (low >> 24) & 0xff;
  // Write high 32-bit half (little-endian)
  out[4] = high & 0xff;
  out[5] = (high >> 8) & 0xff;
  out[6] = (high >> 16) & 0xff;
  out[7] = (high >> 24) & 0xff;

  return out;
}
