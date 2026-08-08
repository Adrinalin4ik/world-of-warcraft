/**
 * A player object's update-object fields -> the `CharacterIdentity` a character look is resolved from.
 *
 * ITS OWN MODULE and not a method on `UpdateObjectHandler`, for one reason worth stating: this is the
 * whole of the world's appearance decoding, it depends on nothing but the field names and `Item.dbc`,
 * and a handler that reaches `GameHandler`, `World`, `three` and the collision layer through its
 * imports cannot be asserted on cheaply. The seam it feeds is `Unit#setCharacterLook`.
 */
import DBC from '../../../../game/pipeline/dbc';
import { CharacterIdentity } from '../../../../game/ui/scene/character-look';

/**
 * One player object's update fields -> the `CharacterIdentity` a look is resolved from.
 *
 * THE FIELD LAYOUT, and every byte offset here is TrinityCore 3.3.5a's own packing rather than a
 * guess:
 *  - `UNIT_FIELD_BYTES_0` = race | class << 8 | gender << 16 | powerType << 24
 *    (`Player::Create`: `SetByteValue(UNIT_FIELD_BYTES_0, 0, race)`, `, 1, class)`, `, 2, gender)`).
 *  - `PLAYER_BYTES` = skin | face << 8 | hairStyle << 16 | hairColor << 24 (`Player::Create`'s
 *    `SetByteValue(PLAYER_BYTES, PLAYER_BYTES_OFFSET_SKIN_ID = 0, skin)` and its three siblings).
 *  - `PLAYER_BYTES_2` byte 0 = facialHair (`PLAYER_BYTES_2_OFFSET_FACIAL_STYLE = 0`). Bytes 2 and 3
 *    are bank bag slots and rest state and are none of a look's business.
 * The reads are `>>> 8` and not `>> 8` because `parseUpdateValues` returns unsigned 32-bit values and
 * hairColor lives in the sign bit.
 *
 * THE ONE THING THE WIRE CANNOT GIVE US DIRECTLY. `PLAYER_VISIBLE_ITEM_n_ENTRYID` is an **item
 * entry**, not a display id -- `SMSG_CHAR_ENUM` carries display ids, the update-object does not
 * (`Player::SetVisibleItemSlot`: `SetUInt32Value(PLAYER_VISIBLE_ITEM_1_ENTRYID + (slot * 2),
 * item->GetEntry())`). So `Item.dbc`'s `displayInfoID` column is the bridge, and it is a table this
 * client has a correct schema for and has never loaded. It is fetched ONLY when a peer player with at
 * least one visible item actually appears, so our own character -- who is dressed from the roster and
 * never reaches this method -- does not pay for it.
 *
 * `null` means "not enough to dress anyone", which is a real case rather than an error: a player
 * object whose update mask did not include `UNIT_FIELD_BYTES_0` (a Values update rather than a
 * create, or a create that only changed health) has no race to look up.
 */
export async function characterIdentityFor(fields: any): Promise<CharacterIdentity | null> {
  const bytes0 = fields?.unit_field_bytes_0;
  if (typeof bytes0 !== 'number') {
    return null;
  }
  const playerBytes = fields.player_bytes ?? 0;
  const playerBytes2 = fields.player_bytes_2 ?? 0;

  const identity: CharacterIdentity = {
    race: bytes0 & 0xff,
    gender: (bytes0 >>> 16) & 0xff,
    appearance: {
      skin: playerBytes & 0xff,
      face: (playerBytes >>> 8) & 0xff,
      hairStyle: (playerBytes >>> 16) & 0xff,
      hairColor: (playerBytes >>> 24) & 0xff,
      facialHair: playerBytes2 & 0xff,
    },
    equipment: [],
  };

  // `EQUIPMENT_SLOT_END` is 19 in 3.3.5a and the fields are numbered from 1, so slot n lives in
  // `player_visible_item_${n + 1}_entryid`. Nothing is stored for an empty slot: `wornEquipmentFor`
  // reads `equipment[slot]?.displayId ?? 0`, so a hole and a zero mean the same thing to it.
  const entries: { slot: number; entry: number }[] = [];
  for (let slot = 0; slot < 19; ++slot) {
    const entry = fields[`player_visible_item_${slot + 1}_entryid`];
    if (typeof entry === 'number' && entry > 0) {
      entries.push({ slot, entry });
    }
  }

  if (entries.length > 0) {
    const table = await DBC.load('Item');
    if (!table) {
      console.warn('update-object: Item.dbc did not load -- peer players draw undressed');
    } else {
      for (const { slot, entry } of entries) {
        // `DBC` indexes its records by id onto itself (`pipeline/dbc/index.js#index`), so this is a
        // property read and not a scan.
        const row = (table as unknown as Record<number, { displayInfoID?: number } | undefined>)[entry];
        if (!row?.displayInfoID) {
          continue;
        }
        identity.equipment[slot] = {
          displayId: row.displayInfoID,
          // `inventoryType` decides only whether a held item goes in the hand or on the back
          // (`character-attachments.ts#placement`), and the update-object does not carry it. `Item.dbc`
          // has `inventorySlotID`, which is the same enum, so the held-slot placement stays correct
          // rather than falling to the "unknown type means a plain weapon" default.
          inventoryType: (row as any).inventorySlotID ?? 0,
          enchantmentId: 0,
        };
      }
    }
  }

  return identity;
}
