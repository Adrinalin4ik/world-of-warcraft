/**
 * The world server's character-management wire format for 3.3.5a, as pure functions over bytes.
 *
 * The char-enum layout mirrors the working parse in `network/characters/handler.js`; create and
 * delete are new. Bodies only -- the opcode and the encrypted header are the transport's business.
 */
import { GUID_BYTES, guidBytes, guidHex } from '../../guid-hex';
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
    //
    // THROUGH `guidHex` AND NOT ITS OWN FORMATTER. This function's inlined loop was the definition of
    // the normalised shape, and `Packet#readPackedGUID` now has to produce the SAME string for the
    // same guid or a roster row and a wire object cannot be recognised as one character. Two copies of
    // a formatter is exactly how that would drift. See `network/guid-hex.ts`.
    const value = guidHex(bytes.subarray(at, at + GUID_BYTES));
    at += GUID_BYTES;
    return value;
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
  // `guidBytes` is the same two-32-bit-half parse this function used to spell out inline, moved so the
  // packed writer shares it. The reason it is halves and not BigInt is unchanged and is recorded at
  // the helper: `tsconfig.json` targets es6, and a 64-bit value has no exact `Number`.
  return guidBytes(guid);
}
