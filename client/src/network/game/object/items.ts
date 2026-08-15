/**
 * ITEMS AS DATA -- the item template query, the item/container descriptor store, and the player's own
 * inventory slot words. Nothing can draw a bag until an item guid resolves to a name, an icon, a stack
 * count and a quality, and before this file NONE of those four had a source in this client.
 *
 * ## Where each of the four actually comes from, because they are four different places
 *
 * This was the first question of the round and the answer is not "a DBC".
 *
 *  - **stack count**: `ITEM_FIELD_STACK_COUNT`, a DESCRIPTOR field on the item object, which arrives in
 *    `SMSG_UPDATE_OBJECT` like any other update field (`enums.ts#ItemField`). It is per-INSTANCE, so no
 *    table anywhere could carry it.
 *  - **name** and **quality**: the SERVER, in `SMSG_ITEM_QUERY_SINGLE_RESPONSE`. 3.3.5a ships no
 *    client-side item name table -- `Item.dbc` has eight columns and not one of them is a name or a
 *    quality (see `wow-data-parser/dbc/entities/item.js`: id, classID, subClassID,
 *    soundOverrideSubClassID, materialID, displayInfoID, inventorySlotID, sheathID). This is the same
 *    shape as `SMSG_CREATURE_QUERY_RESPONSE`, which this client already asks for a mob's name.
 *  - **icon**: `ItemDisplayInfo.dbc`'s `icon` column, reached through a `displayInfoID`. Both the query
 *    response (field 8) and `Item.dbc` (col 5) carry that id, so the icon can resolve from the DBC
 *    before the query lands and from the wire after. The resolver is `pipeline/dbc/item-data.ts`; this
 *    file only carries the id.
 *
 * So it is protocol work plus a cache, exactly as suspected, and only the icon is DBC work.
 *
 * ## THE LAYOUT IS FROM A SERVER IMPLEMENTATION, AND IT IS VALIDATED RATHER THAN TRUSTED
 *
 * Nothing in the game's own data states a packet body. `SMSG_ITEM_QUERY_SINGLE_RESPONSE`'s field order
 * below is transcribed from **TrinityCore 3.3.5**'s `WorldSession::HandleItemQuerySingleOpcode`
 * (`ItemHandler.cpp`) -- the same class of source as this project's `HitInfo` bits and the five
 * combat-log bodies, and labelled here for the same reason. The `consumed`-against-`bodySize` residual
 * in `window.itemWire` is its only oracle; a nonzero residual on a real packet means the layout is
 * wrong, not that the packet was odd.
 *
 * **The 1.12 reference is NOT the layout.** `benilla-protocol/src/messages/items.rs:341-483` is the
 * structure -- entry with the miss bit, class/subclass, four name slots of which three are empty,
 * repeated stat/damage/spell blocks, a resistance run, a u32 tail -- and this file follows that
 * structure. Every version-numbered value differs, and the differences are ELEVEN insertions plus two
 * changed repetition counts:
 *
 *   1. `soundOverrideSubclass i32` after `subclass`                     (2.x)
 *   2. `flags2 u32` after `flags`                                       (3.x)
 *   3. `statsCount u32` BEFORE the stat array, which is therefore
 *      VARIABLE-LENGTH here and a fixed 10 in 1.12                      (3.x)
 *   4. `scalingStatDistribution u32` + `scalingStatValue u32`           (3.x)
 *   5. the damage block repeats **2** times, not 5                      (2.x)
 *   6. `randomSuffix i32` after `randomProperty`                        (2.x)
 *   7. `totemCategory u32` after `bagFamily`                            (2.x)
 *   8. three socket pairs + `socketBonus u32` + `gemProperties u32`     (2.x)
 *   9. `requiredDisenchantSkill i32` + `armorDamageModifier f32`        (2.x)
 *  10. `duration u32` + `itemLimitCategory u32`                         (3.x)
 *  11. `holidayId u32` closes the body                                  (3.x)
 *
 * Item 3 is the sharp one and is the reason a 1.12 transcription does not merely end early but
 * DESYNCS: a fixed 10-entry stat array against a wire that states its own count puts every field after
 * it at the wrong offset. This is the same failure mode as the round that read a WotLK combat-log body
 * on a 1.12 layout, and it is why the residual instrument exists rather than a spot check of the name.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GamePacket from '../packet';
import GameOpcode from '../opcode';
import { ObjectType } from './enums';
import { guidBytes } from '../../guid-hex';
import { itemWire } from '../../../game/classes/item-wire';

/**
 * The fields of `SMSG_ITEM_QUERY_SINGLE_RESPONSE` this client actually consumes.
 *
 * The body carries far more than this (resistances, the spell blocks, the socket triples); everything
 * is READ so the residual can close, and only what a bag, a tooltip or a loot row needs is KEPT. A
 * field kept but never read would be a claim this client understands something it does not.
 */
export interface ItemTemplate {
  entry: number;
  itemClass: number;
  subClass: number;
  /** `GetItemInfo`'s first return, and the loot row's label. */
  name: string;
  /** Into `ItemDisplayInfo.dbc` for the icon -- see the header. */
  displayInfoId: number;
  /** 0 Poor .. 7 Heirloom; `ITEM_QUALITY_COLORS` is indexed by this. */
  quality: number;
  flags: number;
  buyPrice: number;
  sellPrice: number;
  /** `INVTYPE_*`; `GetItemInfo`'s ninth return is the STRING form of this. */
  inventoryType: number;
  itemLevel: number;
  requiredLevel: number;
  /** `GetItemInfo`'s `maxStack`. 0 and 1 both mean "does not stack". */
  stackable: number;
  /** A bag's own size, and how `GetContainerNumSlots` answers before the container object arrives. */
  containerSlots: number;
  bonding: number;
  description: string;
  maxDurability: number;
  startQuest: number;
}

/** A decoded descriptor bag for one item or container object, merged across updates. */
type FieldBag = Record<string | number, number>;

/**
 * The item half of the object layer: template cache, instance descriptors, and the player's own
 * inventory words.
 *
 * Constructed by `ObjectHandler` beside `CombatLogHandler` and fed from two doors -- the wire, for the
 * query response, and `UpdateObjectHandler`, for every item/container create and value block. It owns
 * no UI and knows no Lua; `game/ui/container-bridge.ts` is what reads it.
 */
export class ItemHandler extends EventEmitter {
  private game: GameHandler;

  /**
   * entry -> template, or **null for a MISS**.
   *
   * The null is load-bearing, not a placeholder: the server answers an unknown entry with the lone
   * `entry | 0x80000000` word, and caching that as a negative is what stops an unknown item being
   * re-asked forever. `benilla/src/items.rs:223` keeps the same distinction, and its
   * `template_answered_unknown` (`:231`) exists precisely because "pending" and "answered no" must not
   * look alike to a caller.
   */
  private templates = new Map<number, ItemTemplate | null>();

  /** Entries with a query in flight. The `Set` IS the dedupe -- `items.rs:217`. */
  private pending = new Set<number>();

  /** Item and container descriptor words, by guid, merged across create and value blocks. */
  private objects = new Map<string, FieldBag>();

  /** The object type each stored guid was created as, so a values-only block decodes correctly. */
  private objectTypes = new Map<string, ObjectType>();

  /**
   * OUR OWN character's descriptor words -- the inventory slot guids, the bag slots and the purse.
   *
   * Kept here rather than on `Unit`: `applyUnitFields` deliberately keeps a NAMED subset
   * (`unit-fields.ts:418-439`) and the inventory is 100-odd raw words that no unit frame reads. Merged
   * the same way the item bags are, because a values block carries only what moved.
   */
  private playerBag: FieldBag = {};

  constructor(gameHandler: GameHandler) {
    super();
    this.game = gameHandler;
    this.game.on(
      `packet:receive:${'SMSG_ITEM_QUERY_SINGLE_RESPONSE'}`,
      (gp: GamePacket) => this.handleQueryResponse(gp),
    );
    // A NEW WORLD ENTRY IS A NEW CHARACTER'S INVENTORY. `SMSG_LOGIN_VERIFY_WORLD` is the one message
    // that means "you are now in the world", and this client can reach it twice in a page life -- it
    // reconnects after a disconnect without a reload. Without this, `clearSession` was never called
    // from anywhere and the second character's bag would be drawn over the first's item objects,
    // whose guids are still perfectly valid keys. Found in self-review as dead code, which is what it
    // was; the bug it implies is not theoretical.
    this.game.on('packet:receive:SMSG_LOGIN_VERIFY_WORLD', () => this.clearSession());
  }

  // ---------------------------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------------------------

  /**
   * The cached template for an entry, asking the server for it if this is the first sight.
   *
   * **The read is what issues the query** -- the reference's shape (`items.rs:210-223`) and the right
   * one here: every caller is a UI path that will be re-run when the answer lands (`BAG_UPDATE` fires
   * on `templatesChanged`), so a separate "request" API would only be a second thing to forget to
   * call. The first resolve of a cold entry therefore ALWAYS returns null, and that is normal.
   *
   * `guid` rides along because the server wants it (see `requestTemplate`); it does not participate in
   * the cache key, and a second caller holding a different guid for the same entry does not re-ask.
   */
  template(entry: number, guid = '0x0'): ItemTemplate | null {
    if (!Number.isFinite(entry) || entry <= 0) {
      return null;
    }
    if (!this.templates.has(entry)) {
      if (!this.pending.has(entry)) {
        this.pending.add(entry);
        this.requestTemplate(entry, guid);
      }
      return null;
    }
    return this.templates.get(entry) ?? null;
  }

  /** True once the server has answered this entry with the miss word. Distinguishes it from pending. */
  templateAnsweredUnknown(entry: number): boolean {
    return this.templates.has(entry) && this.templates.get(entry) === null;
  }

  /**
   * `CMSG_ITEM_QUERY_SINGLE` (**0x056**) -- `u32 entry` then a **FULL 8-byte guid**, 12 bytes.
   *
   * The guid is not packed here. That is the reference's reading of the same request
   * (`items.rs:547-551`, `guid.to_le_bytes()`) and it is unchanged in 3.3.5a; a packed guid would be
   * 1-9 bytes and the server's fixed-size read would take the next packet's header as the tail. Zero
   * is a legal value and means "template only, I hold no instance" -- which is what a loot row sends,
   * since a loot slot's item has no guid until it is in a bag.
   */
  private requestTemplate(entry: number, guid: string): void {
    const body = 4 + 8;
    const gp = new GamePacket(
      GameOpcode.CMSG_ITEM_QUERY_SINGLE,
      GamePacket.HEADER_SIZE_OUTGOING + body,
    );
    gp.writeUnsignedInt(entry >>> 0);
    // NOT `writeGUID`: that one takes a `GUID` OBJECT and writes `guid.raw` (`net/packet.js:54-57`),
    // and every guid in this client is the normalised hex STRING (`guid-hex.ts`). `guidBytes` is the
    // one converter, and it already answers 8 little-endian bytes.
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
  }

  /**
   * `SMSG_ITEM_QUERY_SINGLE_RESPONSE` (**0x058**).
   *
   * See the file header for the field order and for where it comes from. Two shapes: the miss is the
   * lone `entry | 0x80000000` word and nothing else, and the hit is the long body.
   *
   * Wrapped the way `combat-log.ts#subscribe` wraps its arms and for the same reason -- `byte-buffer`
   * THROWS on a short read, and an uncaught throw here escapes `GameHandler#dataReceived`'s receive
   * loop and takes every packet still buffered in that data event with it. A layout from a server
   * implementation is a real candidate to be wrong, so the catch is not defensive decoration.
   */
  private handleQueryResponse(gp: GamePacket): void {
    const bodySize = gp.bodySize;
    let entry = 0;
    try {
      const first = gp.readUnsignedInt() >>> 0;
      // THE MISS BIT. `entry | 0x80000000`, the same shape as the creature miss
      // (`items.rs:342-345`). `>>> 0` before the mask, because `&` is an int32 operator and the top
      // bit set makes a bare read negative -- the identical trap `guid-hex.ts` documents.
      if ((first & 0x80000000) !== 0) {
        entry = first & 0x7fffffff;
        this.pending.delete(entry);
        this.templates.set(entry, null);
        itemWire.record({
          at: performance.now(), opcode: 'SMSG_ITEM_QUERY_SINGLE_RESPONSE(miss)', entry,
          name: '', bodySize, consumed: gp.index - gp.headerSize,
        });
        this.emit('templatesChanged');
        return;
      }
      entry = first;
      const template = this.readTemplateBody(gp, entry);
      this.pending.delete(entry);
      this.templates.set(entry, template);
      itemWire.record({
        at: performance.now(), opcode: 'SMSG_ITEM_QUERY_SINGLE_RESPONSE', entry,
        name: template.name, bodySize, consumed: gp.index - gp.headerSize,
      });
      this.emit('templatesChanged');
    } catch (e) {
      // The residual is recorded even on a throw: a layout that over-reads is exactly the case the
      // instrument exists for, so it must not be the one case it cannot see.
      itemWire.record({
        at: performance.now(), opcode: 'SMSG_ITEM_QUERY_SINGLE_RESPONSE!THREW', entry,
        name: '', bodySize, consumed: gp.index - gp.headerSize,
      });
      this.pending.delete(entry);
      this.warnOnce(`read past the ${bodySize} B body -- ${(e as Error).message}`);
    }
  }

  /** The hit body, in wire order. Every field is read; the kept subset is `ItemTemplate`. */
  private readTemplateBody(gp: GamePacket, entry: number): ItemTemplate {
    const itemClass = gp.readUnsignedInt() >>> 0;
    const subClass = gp.readUnsignedInt() >>> 0;
    gp.readInt(); // soundOverrideSubclass -- 2.x insertion, -1 when unset
    const name = gp.readCStr();
    // Three empty name slots. The server writes four and fills one (`items.rs:349-351`); this has not
    // changed, and skipping them by count rather than by content is what keeps a localised build that
    // fills name2 from desyncing.
    //
    // `readCStr`, NOT `readCString`: byte-buffer's own reader does not consume the terminator of an
    // EMPTY string, so these three cost zero bytes instead of three and every field below lands three
    // bytes early. That was measured on this exact packet -- see `net/packet.js#readCStr`.
    for (let i = 0; i < 3; ++i) {
      gp.readCStr();
    }
    const displayInfoId = gp.readUnsignedInt() >>> 0;
    const quality = gp.readUnsignedInt() >>> 0;
    const flags = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // flags2 -- 3.x insertion
    const buyPrice = gp.readUnsignedInt() >>> 0;
    const sellPrice = gp.readUnsignedInt() >>> 0;
    const inventoryType = gp.readUnsignedInt() >>> 0;
    gp.readInt(); // allowableClass, signed, -1 = unrestricted
    gp.readInt(); // allowableRace
    const itemLevel = gp.readUnsignedInt() >>> 0;
    const requiredLevel = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // requiredSkill
    gp.readUnsignedInt(); // requiredSkillRank
    gp.readUnsignedInt(); // requiredSpell
    gp.readUnsignedInt(); // requiredHonorRank
    gp.readUnsignedInt(); // requiredCityRank
    gp.readUnsignedInt(); // requiredReputationFaction
    gp.readUnsignedInt(); // requiredReputationRank
    gp.readInt(); // maxCount
    const stackable = gp.readInt();
    const containerSlots = gp.readUnsignedInt() >>> 0;

    // THE VARIABLE-LENGTH STAT ARRAY -- the 3.x insertion that makes a 1.12 transcription desync
    // rather than merely end early. See the header.
    const statsCount = gp.readUnsignedInt() >>> 0;
    if (statsCount > 32) {
      throw new Error(`statsCount ${statsCount} is not credible -- the layout has desynced`);
    }
    for (let i = 0; i < statsCount; ++i) {
      gp.readUnsignedInt(); // statType
      gp.readInt(); // statValue
    }
    gp.readUnsignedInt(); // scalingStatDistribution -- 3.x
    gp.readUnsignedInt(); // scalingStatValue -- 3.x

    // TWO damage blocks in 3.3.5a, five in 1.12 (`MAX_ITEM_PROTO_DAMAGES`).
    for (let i = 0; i < 2; ++i) {
      gp.readFloat(); // min
      gp.readFloat(); // max
      gp.readUnsignedInt(); // school
    }
    // armor + the six resistances, one run of seven words, as in 1.12.
    for (let i = 0; i < 7; ++i) {
      gp.readInt();
    }
    gp.readUnsignedInt(); // delay
    gp.readUnsignedInt(); // ammoType
    gp.readFloat(); // rangedModRange
    // Five spell blocks of six words. Fixed size on both wires; the server writes sentinels for an
    // empty slot rather than omitting it.
    for (let i = 0; i < 5; ++i) {
      gp.readUnsignedInt(); // spellId
      gp.readUnsignedInt(); // spellTrigger
      gp.readInt(); // spellCharges
      gp.readInt(); // spellCooldown
      gp.readUnsignedInt(); // spellCategory
      gp.readInt(); // spellCategoryCooldown
    }
    const bonding = gp.readUnsignedInt() >>> 0;
    const description = gp.readCStr();
    gp.readUnsignedInt(); // pageText
    gp.readUnsignedInt(); // languageID
    gp.readUnsignedInt(); // pageMaterial
    const startQuest = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // lockID
    gp.readInt(); // material, signed
    gp.readUnsignedInt(); // sheath
    gp.readInt(); // randomProperty
    gp.readInt(); // randomSuffix -- 2.x insertion
    gp.readUnsignedInt(); // block
    gp.readUnsignedInt(); // itemSet
    const maxDurability = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // area
    gp.readInt(); // map
    gp.readUnsignedInt(); // bagFamily
    gp.readUnsignedInt(); // totemCategory -- 2.x
    for (let i = 0; i < 3; ++i) {
      gp.readUnsignedInt(); // socketColor
      gp.readUnsignedInt(); // socketContent
    }
    gp.readUnsignedInt(); // socketBonus
    gp.readUnsignedInt(); // gemProperties
    gp.readInt(); // requiredDisenchantSkill
    gp.readFloat(); // armorDamageModifier
    gp.readUnsignedInt(); // duration -- 3.x
    gp.readUnsignedInt(); // itemLimitCategory
    gp.readUnsignedInt(); // holidayId -- 3.x, and the last word of the body

    return {
      entry,
      itemClass,
      subClass,
      name,
      displayInfoId,
      quality,
      flags,
      buyPrice,
      sellPrice,
      inventoryType,
      itemLevel,
      requiredLevel,
      stackable,
      containerSlots,
      bonding,
      description,
      maxDurability,
      startQuest,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Instance descriptors, fed from `UpdateObjectHandler`
  // ---------------------------------------------------------------------------------------------

  /**
   * An item or container create/values block.
   *
   * MERGED, never replaced: a values block carries only the words that moved, so overwriting the bag
   * would erase the entry and the stack count on the first durability tick. Same reasoning as
   * `applyUnitFields`' per-key `set`.
   */
  noteObject(guid: string, objectType: ObjectType, values: FieldBag, create: boolean): void {
    if (objectType !== ObjectType.Item && objectType !== ObjectType.Container) {
      return;
    }
    if (create) {
      this.objectTypes.set(guid, objectType);
    }
    const existing = this.objects.get(guid);
    this.objects.set(guid, existing ? Object.assign(existing, values) : { ...values });
    this.emit('inventoryChanged');
  }

  /** An item or container leaving the world (destroyed, sold, traded away). */
  forgetObject(guid: string): void {
    if (this.objects.delete(guid)) {
      this.objectTypes.delete(guid);
      this.emit('inventoryChanged');
    }
  }

  /** The type a guid was created as, so `UpdateObjectHandler` can decode a later values-only block. */
  objectTypeOf(guid: string): ObjectType | undefined {
    return this.objectTypes.get(guid);
  }

  /** Our own character's descriptor words. Merged for the same reason `noteObject` merges. */
  notePlayerFields(values: FieldBag): void {
    Object.assign(this.playerBag, values);
    this.emit('inventoryChanged');
  }

  /** The raw descriptor bag for an item guid, or null. */
  object(guid: string): FieldBag | null {
    return this.objects.get(guid) ?? null;
  }

  /** Our own character's raw descriptor bag. */
  player(): FieldBag {
    return this.playerBag;
  }

  /** Every guid this client currently holds an item/container descriptor for. */
  objectGuids(): string[] {
    return [...this.objects.keys()];
  }

  /**
   * Dropped on world entry. Templates SURVIVE -- an item definition is stable across sessions and
   * across characters, which is the reference's reasoning too (`benilla/src/items.rs`' header: "Templates
   * survive disconnect: item definitions are stable across sessions"). Everything keyed by a guid does
   * not.
   */
  clearSession(): void {
    this.objects.clear();
    this.objectTypes.clear();
    this.playerBag = {};
    this.pending.clear();
  }

  private warned = new Set<string>();

  private warnOnce(detail: string): void {
    if (this.warned.has(detail)) {
      return;
    }
    this.warned.add(detail);
    console.warn(
      `items: SMSG_ITEM_QUERY_SINGLE_RESPONSE did not decode -- ${detail}. This layout comes from a`
      + ' SERVER implementation (see the header of network/game/object/items.ts) and is validated'
      + ' rather than trusted. Read window.itemWire.census().',
    );
  }
}

export default ItemHandler;
