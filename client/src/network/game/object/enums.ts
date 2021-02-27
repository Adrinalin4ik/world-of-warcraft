export enum UpdateType {
  Values        = 0,
  Movement      = 1,
  CreateObject1 = 2,
  CreateObject2 = 3,
  FarObjects    = 4,
  NearObjects   = 5
}

export enum ObjectType {
  Object        = 0,
  Item          = 1,
  Container     = 2,
  Unit          = 3,
  Player        = 4,
  GameObject    = 5,
  DynamicObject = 6,
  Corpse        = 7,
  AreaTrigger   = 8,
  SceneObject   = 9,
  Conversation  = 10
}

export enum UpdateFlags {
  /// <summary>
  /// No flag set.
  /// </summary>
  UPDATEFLAG_NONE = 0x00,
  /// <summary>
  /// Update flag for self.
  /// </summary>
  UPDATEFLAG_SELFTARGET = 0x01,
  /// <summary>
  /// Update flag for transport object.
  /// </summary>
  UPDATEFLAG_TRANSPORT = 0x02,
  /// <summary>
  /// Update flag with target guid.
  /// </summary>
  UPDATEFLAG_TARGET_GUID = 0x04,
  /// <summary>
  /// Update flag unknown...
  /// </summary>
  UPDATEFLAG_UNK = 0x08,
  /// <summary>
  /// Common update flag.
  /// </summary>
  UPDATEFLAG_LOWGUID = 0x10,
  /// <summary>
  /// Update flag for living objects.
  /// </summary>
  UPDATEFLAG_LIVING = 0x20,
  /// <summary>
  /// Update flag for world objects (players, units, go, do, corpses).
  /// </summary>
  UPDATEFLAG_HAS_POSITION = 0x40,
  /// <summary>
  /// Unknown, added in WotLK Beta
  /// </summary>
  UPDATEFLAG_VEHICLE = 0x80,
  /// <summary>
  /// Unknown, added in 3.1
  /// </summary>
  UPDATEFLAG_GO_POSITION = 0x100,
  /// <summary>
  /// Unknown, added in 3.1
  /// </summary>
  UPDATEFLAG_GO_ROTATION = 0x200,
  /// <summary>
  /// Unknown, added in 3.1+
  /// </summary>
  UPDATEFLAG_UNK1 = 0x400,
}

// resharper disable inconsistentnaming
// 3.3.5
export const ObjectField = {
    object_field_guid: 0x0000,
    object_field_type: 0x0002,
    object_field_entry: 0x0003,
    object_field_scale_x: 0x0004,
    object_field_padding: 0x0005,
    object_end: 0x0006
}

export const ItemField = {
    item_field_owner: ObjectField.object_end + 0x0000,
    item_field_contained: ObjectField.object_end + 0x0002,
    item_field_creator: ObjectField.object_end + 0x0004,
    item_field_giftcreator: ObjectField.object_end + 0x0006,
    item_field_stack_count: ObjectField.object_end + 0x0008,
    item_field_duration: ObjectField.object_end + 0x0009,
    item_field_spell_charges: ObjectField.object_end + 0x000a,
    item_field_flags: ObjectField.object_end + 0x000f,
    item_field_enchantment_1_1: ObjectField.object_end + 0x0010,
    item_field_enchantment_1_3: ObjectField.object_end + 0x0012,
    item_field_enchantment_2_1: ObjectField.object_end + 0x0013,
    item_field_enchantment_2_3: ObjectField.object_end + 0x0015,
    item_field_enchantment_3_1: ObjectField.object_end + 0x0016,
    item_field_enchantment_3_3: ObjectField.object_end + 0x0018,
    item_field_enchantment_4_1: ObjectField.object_end + 0x0019,
    item_field_enchantment_4_3: ObjectField.object_end + 0x001b,
    item_field_enchantment_5_1: ObjectField.object_end + 0x001c,
    item_field_enchantment_5_3: ObjectField.object_end + 0x001e,
    item_field_enchantment_6_1: ObjectField.object_end + 0x001f,
    item_field_enchantment_6_3: ObjectField.object_end + 0x0021,
    item_field_enchantment_7_1: ObjectField.object_end + 0x0022,
    item_field_enchantment_7_3: ObjectField.object_end + 0x0024,
    item_field_enchantment_8_1: ObjectField.object_end + 0x0025,
    item_field_enchantment_8_3: ObjectField.object_end + 0x0027,
    item_field_enchantment_9_1: ObjectField.object_end + 0x0028,
    item_field_enchantment_9_3: ObjectField.object_end + 0x002a,
    item_field_enchantment_10_1: ObjectField.object_end + 0x002b,
    item_field_enchantment_10_3: ObjectField.object_end + 0x002d,
    item_field_enchantment_11_1: ObjectField.object_end + 0x002e,
    item_field_enchantment_11_3: ObjectField.object_end + 0x0030,
    item_field_enchantment_12_1: ObjectField.object_end + 0x0031,
    item_field_enchantment_12_3: ObjectField.object_end + 0x0033,
    item_field_property_seed: ObjectField.object_end + 0x0034,
    item_field_random_properties_id: ObjectField.object_end + 0x0035,
    item_field_durability: ObjectField.object_end + 0x0036,
    item_field_maxdurability: ObjectField.object_end + 0x0037,
    item_field_create_played_time: ObjectField.object_end + 0x0038,
    item_field_pad: ObjectField.object_end + 0x0039,
    item_end: ObjectField.object_end + 0x003a
}

export const ContainerField = {
    container_field_num_slots: ItemField.item_end + 0x0000,
    container_align_pad: ItemField.item_end + 0x0001,
    container_field_slot_1: ItemField.item_end + 0x0002,
    container_end: ItemField.item_end + 0x004a
}

export const UnitField = {
    unit_field_charm: ObjectField.object_end + 0x0000,
    unit_field_summon: ObjectField.object_end + 0x0002,
    unit_field_critter: ObjectField.object_end + 0x0004,
    unit_field_charmedby: ObjectField.object_end + 0x0006,
    unit_field_summonedby: ObjectField.object_end + 0x0008,
    unit_field_createdby: ObjectField.object_end + 0x000a,
    unit_field_target: ObjectField.object_end + 0x000c,
    unit_field_channel_object: ObjectField.object_end + 0x000e,
    unit_channel_spell: ObjectField.object_end + 0x0010,
    unit_field_bytes_0: ObjectField.object_end + 0x0011,
    unit_field_health: ObjectField.object_end + 0x0012,
    unit_field_power1: ObjectField.object_end + 0x0013,
    unit_field_power2: ObjectField.object_end + 0x0014,
    unit_field_power3: ObjectField.object_end + 0x0015,
    unit_field_power4: ObjectField.object_end + 0x0016,
    unit_field_power5: ObjectField.object_end + 0x0017,
    unit_field_power6: ObjectField.object_end + 0x0018,
    unit_field_power7: ObjectField.object_end + 0x0019,
    unit_field_maxhealth: ObjectField.object_end + 0x001a,
    unit_field_maxpower1: ObjectField.object_end + 0x001b,
    unit_field_maxpower2: ObjectField.object_end + 0x001c,
    unit_field_maxpower3: ObjectField.object_end + 0x001d,
    unit_field_maxpower4: ObjectField.object_end + 0x001e,
    unit_field_maxpower5: ObjectField.object_end + 0x001f,
    unit_field_maxpower6: ObjectField.object_end + 0x0020,
    unit_field_maxpower7: ObjectField.object_end + 0x0021,
    unit_field_power_regen_flat_modifier: ObjectField.object_end + 0x0022,
    unit_field_power_regen_interrupted_flat_modifier: ObjectField.object_end + 0x0029,
    unit_field_level: ObjectField.object_end + 0x0030,
    unit_field_factiontemplate: ObjectField.object_end + 0x0031,
    unit_virtual_item_slot_id: ObjectField.object_end + 0x0032,
    unit_field_flags: ObjectField.object_end + 0x0035,
    unit_field_flags_2: ObjectField.object_end + 0x0036,
    unit_field_aurastate: ObjectField.object_end + 0x0037,
    unit_field_baseattacktime: ObjectField.object_end + 0x0038,
    unit_field_unk63: ObjectField.object_end + 0x0039,
    unit_field_rangedattacktime: ObjectField.object_end + 0x003a,
    unit_field_boundingradius: ObjectField.object_end + 0x003b,
    unit_field_combatreach: ObjectField.object_end + 0x003c,
    unit_field_displayid: ObjectField.object_end + 0x003d,
    unit_field_nativedisplayid: ObjectField.object_end + 0x003e,
    unit_field_mountdisplayid: ObjectField.object_end + 0x003f,
    unit_field_mindamage: ObjectField.object_end + 0x0040,
    unit_field_maxdamage: ObjectField.object_end + 0x0041,
    unit_field_minoffhanddamage: ObjectField.object_end + 0x0042,
    unit_field_maxoffhanddamage: ObjectField.object_end + 0x0043,
    unit_field_bytes_1: ObjectField.object_end + 0x0044,
    unit_field_petnumber: ObjectField.object_end + 0x0045,
    unit_field_pet_name_timestamp: ObjectField.object_end + 0x0046,
    unit_field_petexperience: ObjectField.object_end + 0x0047,
    unit_field_petnextlevelexp: ObjectField.object_end + 0x0048,
    unit_dynamic_flags: ObjectField.object_end + 0x0049,
    unit_mod_cast_speed: ObjectField.object_end + 0x004a,
    unit_created_by_spell: ObjectField.object_end + 0x004b,
    unit_npc_flags: ObjectField.object_end + 0x004c,
    unit_npc_emotestate: ObjectField.object_end + 0x004d,
    unit_field_stat0: ObjectField.object_end + 0x004e,
    unit_field_stat1: ObjectField.object_end + 0x004f,
    unit_field_stat2: ObjectField.object_end + 0x0050,
    unit_field_stat3: ObjectField.object_end + 0x0051,
    unit_field_stat4: ObjectField.object_end + 0x0052,
    unit_field_posstat0: ObjectField.object_end + 0x0053,
    unit_field_posstat1: ObjectField.object_end + 0x0054,
    unit_field_posstat2: ObjectField.object_end + 0x0055,
    unit_field_posstat3: ObjectField.object_end + 0x0056,
    unit_field_posstat4: ObjectField.object_end + 0x0057,
    unit_field_negstat0: ObjectField.object_end + 0x0058,
    unit_field_negstat1: ObjectField.object_end + 0x0059,
    unit_field_negstat2: ObjectField.object_end + 0x005a,
    unit_field_negstat3: ObjectField.object_end + 0x005b,
    unit_field_negstat4: ObjectField.object_end + 0x005c,
    unit_field_resistances_armor: ObjectField.object_end + 0x005d,
    unit_field_resistances_holy: ObjectField.object_end + 0x005e,
    unit_field_resistances_fire: ObjectField.object_end + 0x005f,
    unit_field_resistances_nature: ObjectField.object_end + 0x0060,
    unit_field_resistances_frost: ObjectField.object_end + 0x0061,
    unit_field_resistances_shadow: ObjectField.object_end + 0x0062,
    unit_field_resistances_arcane: ObjectField.object_end + 0x0063,
    unit_field_resistancebuffmodspositive_armor: ObjectField.object_end + 0x0064,
    unit_field_resistancebuffmodspositive_holy: ObjectField.object_end + 0x0065,
    unit_field_resistancebuffmodspositive_fire: ObjectField.object_end + 0x0066,
    unit_field_resistancebuffmodspositive_nature: ObjectField.object_end + 0x0067,
    unit_field_resistancebuffmodspositive_frost: ObjectField.object_end + 0x0068,
    unit_field_resistancebuffmodspositive_shadow: ObjectField.object_end + 0x0069,
    unit_field_resistancebuffmodspositive_arcane: ObjectField.object_end + 0x006a,
    unit_field_resistancebuffmodsnegative_armor: ObjectField.object_end + 0x006b,
    unit_field_resistancebuffmodsnegative_holy: ObjectField.object_end + 0x006c,
    unit_field_resistancebuffmodsnegative_fire: ObjectField.object_end + 0x006d,
    unit_field_resistancebuffmodsnegative_nature: ObjectField.object_end + 0x006e,
    unit_field_resistancebuffmodsnegative_frost: ObjectField.object_end + 0x006f,
    unit_field_resistancebuffmodsnegative_shadow: ObjectField.object_end + 0x0070,
    unit_field_resistancebuffmodsnegative_arcane: ObjectField.object_end + 0x0071,
    unit_field_base_mana: ObjectField.object_end + 0x0072,
    unit_field_base_health: ObjectField.object_end + 0x0073,
    unit_field_bytes_2: ObjectField.object_end + 0x0074,
    unit_field_attack_power: ObjectField.object_end + 0x0075,
    unit_field_attack_power_mods: ObjectField.object_end + 0x0076,
    unit_field_attack_power_multiplier: ObjectField.object_end + 0x0077,
    unit_field_ranged_attack_power: ObjectField.object_end + 0x0078,
    unit_field_ranged_attack_power_mods: ObjectField.object_end + 0x0079,
    unit_field_ranged_attack_power_multiplier: ObjectField.object_end + 0x007a,
    unit_field_minrangeddamage: ObjectField.object_end + 0x007b,
    unit_field_maxrangeddamage: ObjectField.object_end + 0x007c,
    unit_field_power_cost_modifier: ObjectField.object_end + 0x007d,
    unit_field_power_cost_multiplier1: ObjectField.object_end + 0x0084,
    unit_field_power_cost_multiplier2: ObjectField.object_end + 0x0085,
    unit_field_power_cost_multiplier3: ObjectField.object_end + 0x0086,
    unit_field_power_cost_multiplier4: ObjectField.object_end + 0x0087,
    unit_field_power_cost_multiplier5: ObjectField.object_end + 0x0088,
    unit_field_power_cost_multiplier6: ObjectField.object_end + 0x0089,
    unit_field_power_cost_multiplier7: ObjectField.object_end + 0x008a,
    unit_field_maxhealthmodifier: ObjectField.object_end + 0x008b,
    unit_field_hoverheight: ObjectField.object_end + 0x008c,
    unit_field_padding: ObjectField.object_end + 0x008d,
    unit_end: ObjectField.object_end + 0x008e
}

export const PlayerField = {
    player_duel_arbiter: UnitField.unit_end + 0x0000,
    player_flags: UnitField.unit_end + 0x0002,
    player_guildid: UnitField.unit_end + 0x0003,
    player_guildrank: UnitField.unit_end + 0x0004,
    player_bytes: UnitField.unit_end + 0x0005,
    player_bytes_2: UnitField.unit_end + 0x0006,
    player_bytes_3: UnitField.unit_end + 0x0007,
    player_duel_team: UnitField.unit_end + 0x0008,
    player_guild_timestamp: UnitField.unit_end + 0x0009,
    player_quest_log_1_1: UnitField.unit_end + 0x000a,
    player_quest_log_1_2: UnitField.unit_end + 0x000b,
    player_quest_log_1_3: UnitField.unit_end + 0x000c,
    player_quest_log_1_4: UnitField.unit_end + 0x000e,
    player_quest_log_2_1: UnitField.unit_end + 0x000f,
    player_quest_log_2_2: UnitField.unit_end + 0x0010,
    player_quest_log_2_3: UnitField.unit_end + 0x0011,
    player_quest_log_2_5: UnitField.unit_end + 0x0013,
    player_quest_log_3_1: UnitField.unit_end + 0x0014,
    player_quest_log_3_2: UnitField.unit_end + 0x0015,
    player_quest_log_3_3: UnitField.unit_end + 0x0016,
    player_quest_log_3_5: UnitField.unit_end + 0x0018,
    player_quest_log_4_1: UnitField.unit_end + 0x0019,
    player_quest_log_4_2: UnitField.unit_end + 0x001a,
    player_quest_log_4_3: UnitField.unit_end + 0x001b,
    player_quest_log_4_5: UnitField.unit_end + 0x001d,
    player_quest_log_5_1: UnitField.unit_end + 0x001e,
    player_quest_log_5_2: UnitField.unit_end + 0x001f,
    player_quest_log_5_3: UnitField.unit_end + 0x0020,
    player_quest_log_5_5: UnitField.unit_end + 0x0022,
    player_quest_log_6_1: UnitField.unit_end + 0x0023,
    player_quest_log_6_2: UnitField.unit_end + 0x0024,
    player_quest_log_6_3: UnitField.unit_end + 0x0025,
    player_quest_log_6_5: UnitField.unit_end + 0x0027,
    player_quest_log_7_1: UnitField.unit_end + 0x0028,
    player_quest_log_7_2: UnitField.unit_end + 0x0029,
    player_quest_log_7_3: UnitField.unit_end + 0x002a,
    player_quest_log_7_5: UnitField.unit_end + 0x002c,
    player_quest_log_8_1: UnitField.unit_end + 0x002d,
    player_quest_log_8_2: UnitField.unit_end + 0x002e,
    player_quest_log_8_3: UnitField.unit_end + 0x002f,
    player_quest_log_8_5: UnitField.unit_end + 0x0031,
    player_quest_log_9_1: UnitField.unit_end + 0x0032,
    player_quest_log_9_2: UnitField.unit_end + 0x0033,
    player_quest_log_9_3: UnitField.unit_end + 0x0034,
    player_quest_log_9_5: UnitField.unit_end + 0x0036,
    player_quest_log_10_1: UnitField.unit_end + 0x0037,
    player_quest_log_10_2: UnitField.unit_end + 0x0038,
    player_quest_log_10_3: UnitField.unit_end + 0x0039,
    player_quest_log_10_5: UnitField.unit_end + 0x003b,
    player_quest_log_11_1: UnitField.unit_end + 0x003c,
    player_quest_log_11_2: UnitField.unit_end + 0x003d,
    player_quest_log_11_3: UnitField.unit_end + 0x003e,
    player_quest_log_11_5: UnitField.unit_end + 0x0040,
    player_quest_log_12_1: UnitField.unit_end + 0x0041,
    player_quest_log_12_2: UnitField.unit_end + 0x0042,
    player_quest_log_12_3: UnitField.unit_end + 0x0043,
    player_quest_log_12_5: UnitField.unit_end + 0x0045,
    player_quest_log_13_1: UnitField.unit_end + 0x0046,
    player_quest_log_13_2: UnitField.unit_end + 0x0047,
    player_quest_log_13_3: UnitField.unit_end + 0x0048,
    player_quest_log_13_5: UnitField.unit_end + 0x004a,
    player_quest_log_14_1: UnitField.unit_end + 0x004b,
    player_quest_log_14_2: UnitField.unit_end + 0x004c,
    player_quest_log_14_3: UnitField.unit_end + 0x004d,
    player_quest_log_14_5: UnitField.unit_end + 0x004f,
    player_quest_log_15_1: UnitField.unit_end + 0x0050,
    player_quest_log_15_2: UnitField.unit_end + 0x0051,
    player_quest_log_15_3: UnitField.unit_end + 0x0052,
    player_quest_log_15_5: UnitField.unit_end + 0x0054,
    player_quest_log_16_1: UnitField.unit_end + 0x0055,
    player_quest_log_16_2: UnitField.unit_end + 0x0056,
    player_quest_log_16_3: UnitField.unit_end + 0x0057,
    player_quest_log_16_5: UnitField.unit_end + 0x0059,
    player_quest_log_17_1: UnitField.unit_end + 0x005a,
    player_quest_log_17_2: UnitField.unit_end + 0x005b,
    player_quest_log_17_3: UnitField.unit_end + 0x005c,
    player_quest_log_17_5: UnitField.unit_end + 0x005e,
    player_quest_log_18_1: UnitField.unit_end + 0x005f,
    player_quest_log_18_2: UnitField.unit_end + 0x0060,
    player_quest_log_18_3: UnitField.unit_end + 0x0061,
    player_quest_log_18_5: UnitField.unit_end + 0x0063,
    player_quest_log_19_1: UnitField.unit_end + 0x0064,
    player_quest_log_19_2: UnitField.unit_end + 0x0065,
    player_quest_log_19_3: UnitField.unit_end + 0x0066,
    player_quest_log_19_5: UnitField.unit_end + 0x0068,
    player_quest_log_20_1: UnitField.unit_end + 0x0069,
    player_quest_log_20_2: UnitField.unit_end + 0x006a,
    player_quest_log_20_3: UnitField.unit_end + 0x006b,
    player_quest_log_20_5: UnitField.unit_end + 0x006d,
    player_quest_log_21_1: UnitField.unit_end + 0x006e,
    player_quest_log_21_2: UnitField.unit_end + 0x006f,
    player_quest_log_21_3: UnitField.unit_end + 0x0070,
    player_quest_log_21_5: UnitField.unit_end + 0x0072,
    player_quest_log_22_1: UnitField.unit_end + 0x0073,
    player_quest_log_22_2: UnitField.unit_end + 0x0074,
    player_quest_log_22_3: UnitField.unit_end + 0x0075,
    player_quest_log_22_5: UnitField.unit_end + 0x0077,
    player_quest_log_23_1: UnitField.unit_end + 0x0078,
    player_quest_log_23_2: UnitField.unit_end + 0x0079,
    player_quest_log_23_3: UnitField.unit_end + 0x007a,
    player_quest_log_23_5: UnitField.unit_end + 0x007c,
    player_quest_log_24_1: UnitField.unit_end + 0x007d,
    player_quest_log_24_2: UnitField.unit_end + 0x007e,
    player_quest_log_24_3: UnitField.unit_end + 0x007f,
    player_quest_log_24_5: UnitField.unit_end + 0x0081,
    player_quest_log_25_1: UnitField.unit_end + 0x0082,
    player_quest_log_25_2: UnitField.unit_end + 0x0083,
    player_quest_log_25_3: UnitField.unit_end + 0x0084,
    player_quest_log_25_5: UnitField.unit_end + 0x0086,
    player_visible_item_1_entryid: UnitField.unit_end + 0x0087,
    player_visible_item_1_enchantment: UnitField.unit_end + 0x0088,
    player_visible_item_2_entryid: UnitField.unit_end + 0x0089,
    player_visible_item_2_enchantment: UnitField.unit_end + 0x008a,
    player_visible_item_3_entryid: UnitField.unit_end + 0x008b,
    player_visible_item_3_enchantment: UnitField.unit_end + 0x008c,
    player_visible_item_4_entryid: UnitField.unit_end + 0x008d,
    player_visible_item_4_enchantment: UnitField.unit_end + 0x008e,
    player_visible_item_5_entryid: UnitField.unit_end + 0x008f,
    player_visible_item_5_enchantment: UnitField.unit_end + 0x0090,
    player_visible_item_6_entryid: UnitField.unit_end + 0x0091,
    player_visible_item_6_enchantment: UnitField.unit_end + 0x0092,
    player_visible_item_7_entryid: UnitField.unit_end + 0x0093,
    player_visible_item_7_enchantment: UnitField.unit_end + 0x0094,
    player_visible_item_8_entryid: UnitField.unit_end + 0x0095,
    player_visible_item_8_enchantment: UnitField.unit_end + 0x0096,
    player_visible_item_9_entryid: UnitField.unit_end + 0x0097,
    player_visible_item_9_enchantment: UnitField.unit_end + 0x0098,
    player_visible_item_10_entryid: UnitField.unit_end + 0x0099,
    player_visible_item_10_enchantment: UnitField.unit_end + 0x009a,
    player_visible_item_11_entryid: UnitField.unit_end + 0x009b,
    player_visible_item_11_enchantment: UnitField.unit_end + 0x009c,
    player_visible_item_12_entryid: UnitField.unit_end + 0x009d,
    player_visible_item_12_enchantment: UnitField.unit_end + 0x009e,
    player_visible_item_13_entryid: UnitField.unit_end + 0x009f,
    player_visible_item_13_enchantment: UnitField.unit_end + 0x00a0,
    player_visible_item_14_entryid: UnitField.unit_end + 0x00a1,
    player_visible_item_14_enchantment: UnitField.unit_end + 0x00a2,
    player_visible_item_15_entryid: UnitField.unit_end + 0x00a3,
    player_visible_item_15_enchantment: UnitField.unit_end + 0x00a4,
    player_visible_item_16_entryid: UnitField.unit_end + 0x00a5,
    player_visible_item_16_enchantment: UnitField.unit_end + 0x00a6,
    player_visible_item_17_entryid: UnitField.unit_end + 0x00a7,
    player_visible_item_17_enchantment: UnitField.unit_end + 0x00a8,
    player_visible_item_18_entryid: UnitField.unit_end + 0x00a9,
    player_visible_item_18_enchantment: UnitField.unit_end + 0x00aa,
    player_visible_item_19_entryid: UnitField.unit_end + 0x00ab,
    player_visible_item_19_enchantment: UnitField.unit_end + 0x00ac,
    player_chosen_title: UnitField.unit_end + 0x00ad,
    player_fake_inebriation: UnitField.unit_end + 0x00ae,
    player_field_pad_0: UnitField.unit_end + 0x00af,
    player_field_inv_slot_head: UnitField.unit_end + 0x00b0,
    player_field_inv_slot_fixme1: UnitField.unit_end + 0x00b2,
    player_field_inv_slot_fixme2: UnitField.unit_end + 0x00b4,
    player_field_inv_slot_fixme3: UnitField.unit_end + 0x00b6,
    player_field_inv_slot_fixme4: UnitField.unit_end + 0x00b8,
    player_field_inv_slot_fixme5: UnitField.unit_end + 0x00ba,
    player_field_inv_slot_fixme6: UnitField.unit_end + 0x00bc,
    player_field_inv_slot_fixme7: UnitField.unit_end + 0x00be,
    player_field_inv_slot_fixme8: UnitField.unit_end + 0x00c0,
    player_field_inv_slot_fixme9: UnitField.unit_end + 0x00c2,
    player_field_inv_slot_fixme10: UnitField.unit_end + 0x00c4,
    player_field_inv_slot_fixme11: UnitField.unit_end + 0x00c6,
    player_field_inv_slot_fixme12: UnitField.unit_end + 0x00c8,
    player_field_inv_slot_fixme13: UnitField.unit_end + 0x00ca,
    player_field_inv_slot_fixme14: UnitField.unit_end + 0x00cc,
    player_field_inv_slot_fixme15: UnitField.unit_end + 0x00ce,
    player_field_inv_slot_fixme16: UnitField.unit_end + 0x00d0,
    player_field_inv_slot_fixme17: UnitField.unit_end + 0x00d2,
    player_field_inv_slot_fixme18: UnitField.unit_end + 0x00d4,
    player_field_inv_slot_fixme19: UnitField.unit_end + 0x00d6,
    player_field_inv_slot_fixme20: UnitField.unit_end + 0x00d8,
    player_field_inv_slot_fixme21: UnitField.unit_end + 0x00da,
    player_field_inv_slot_fixme22: UnitField.unit_end + 0x00dc,
    player_field_pack_slot_1: UnitField.unit_end + 0x00de,
    player_field_bank_slot_1: UnitField.unit_end + 0x00fe,
    player_field_bankbag_slot_1: UnitField.unit_end + 0x0136,
    player_field_vendorbuyback_slot_1: UnitField.unit_end + 0x0144,
    player_field_keyring_slot_1: UnitField.unit_end + 0x015c,
    player_field_currencytoken_slot_1: UnitField.unit_end + 0x019c,
    player_farsight: UnitField.unit_end + 0x01dc,
    player_field_known_titles: UnitField.unit_end + 0x01de,
    player_field_known_titles1: UnitField.unit_end + 0x01e0,
    player_field_known_titles2: UnitField.unit_end + 0x01e2,
    player_field_known_currencies: UnitField.unit_end + 0x01e4,
    player_xp: UnitField.unit_end + 0x01e6,
    player_next_level_xp: UnitField.unit_end + 0x01e7,
    player_skill_info_1_1: UnitField.unit_end + 0x01e8,
    player_character_points1: UnitField.unit_end + 0x0368,
    player_character_points2: UnitField.unit_end + 0x0369,
    player_track_creatures: UnitField.unit_end + 0x036a,
    player_track_resources: UnitField.unit_end + 0x036b,
    player_block_percentage: UnitField.unit_end + 0x036c,
    player_dodge_percentage: UnitField.unit_end + 0x036d,
    player_parry_percentage: UnitField.unit_end + 0x036e,
    player_expertise: UnitField.unit_end + 0x036f,
    player_offhand_expertise: UnitField.unit_end + 0x0370,
    player_crit_percentage: UnitField.unit_end + 0x0371,
    player_ranged_crit_percentage: UnitField.unit_end + 0x0372,
    player_offhand_crit_percentage: UnitField.unit_end + 0x0373,
    player_spell_crit_percentage1: UnitField.unit_end + 0x0374,
    player_spell_crit_percentage2: UnitField.unit_end + 0x0375,
    player_spell_crit_percentage3: UnitField.unit_end + 0x0376,
    player_spell_crit_percentage4: UnitField.unit_end + 0x0377,
    player_spell_crit_percentage5: UnitField.unit_end + 0x0378,
    player_spell_crit_percentage6: UnitField.unit_end + 0x0379,
    player_spell_crit_percentage7: UnitField.unit_end + 0x037a,
    player_shield_block: UnitField.unit_end + 0x037b,
    player_shield_block_crit_percentage: UnitField.unit_end + 0x037c,
    player_explored_zones_1: UnitField.unit_end + 0x037d,
    player_rest_state_experience: UnitField.unit_end + 0x03fd,
    player_field_coinage: UnitField.unit_end + 0x03fe,
    player_field_mod_damage_done_pos: UnitField.unit_end + 0x03ff,
    player_field_mod_damage_done_neg: UnitField.unit_end + 0x0406,
    player_field_mod_damage_done_pct1: UnitField.unit_end + 0x040d,
    player_field_mod_damage_done_pct2: UnitField.unit_end + 0x040e,
    player_field_mod_damage_done_pct3: UnitField.unit_end + 0x040f,
    player_field_mod_damage_done_pct4: UnitField.unit_end + 0x0410,
    player_field_mod_damage_done_pct5: UnitField.unit_end + 0x0411,
    player_field_mod_damage_done_pct6: UnitField.unit_end + 0x0412,
    player_field_mod_damage_done_pct7: UnitField.unit_end + 0x0413,
    player_field_mod_healing_done_pos: UnitField.unit_end + 0x0414,
    player_field_mod_healing_pct: UnitField.unit_end + 0x0415,
    player_field_mod_healing_done_pct: UnitField.unit_end + 0x0416,
    player_field_mod_target_resistance: UnitField.unit_end + 0x0417,
    player_field_mod_target_physical_resistance: UnitField.unit_end + 0x0418,
    player_field_bytes: UnitField.unit_end + 0x0419,
    player_ammo_id: UnitField.unit_end + 0x041a,
    player_self_res_spell: UnitField.unit_end + 0x041b,
    player_field_pvp_medals: UnitField.unit_end + 0x041c,
    player_field_buyback_price_1: UnitField.unit_end + 0x041d,
    player_field_buyback_price_2: UnitField.unit_end + 0x041e,
    player_field_buyback_price_3: UnitField.unit_end + 0x041f,
    player_field_buyback_price_4: UnitField.unit_end + 0x0420,
    player_field_buyback_price_5: UnitField.unit_end + 0x0421,
    player_field_buyback_price_6: UnitField.unit_end + 0x0422,
    player_field_buyback_price_7: UnitField.unit_end + 0x0423,
    player_field_buyback_price_8: UnitField.unit_end + 0x0424,
    player_field_buyback_price_9: UnitField.unit_end + 0x0425,
    player_field_buyback_price_10: UnitField.unit_end + 0x0426,
    player_field_buyback_price_11: UnitField.unit_end + 0x0427,
    player_field_buyback_price_12: UnitField.unit_end + 0x0428,
    player_field_buyback_timestamp_1: UnitField.unit_end + 0x0429,
    player_field_buyback_timestamp_2: UnitField.unit_end + 0x042a,
    player_field_buyback_timestamp_3: UnitField.unit_end + 0x042b,
    player_field_buyback_timestamp_4: UnitField.unit_end + 0x042c,
    player_field_buyback_timestamp_5: UnitField.unit_end + 0x042d,
    player_field_buyback_timestamp_6: UnitField.unit_end + 0x042e,
    player_field_buyback_timestamp_7: UnitField.unit_end + 0x042f,
    player_field_buyback_timestamp_8: UnitField.unit_end + 0x0430,
    player_field_buyback_timestamp_9: UnitField.unit_end + 0x0431,
    player_field_buyback_timestamp_10: UnitField.unit_end + 0x0432,
    player_field_buyback_timestamp_11: UnitField.unit_end + 0x0433,
    player_field_buyback_timestamp_12: UnitField.unit_end + 0x0434,
    player_field_kills: UnitField.unit_end + 0x0435,
    player_field_today_contribution: UnitField.unit_end + 0x0436,
    player_field_yesterday_contribution: UnitField.unit_end + 0x0437,
    player_field_lifetime_honorable_kills: UnitField.unit_end + 0x0438,
    player_field_bytes2: UnitField.unit_end + 0x0439,
    player_field_watched_faction_index: UnitField.unit_end + 0x043a,
    player_field_combat_rating_1: UnitField.unit_end + 0x043b,
    player_field_arena_team_info_1_1: UnitField.unit_end + 0x0454,
    player_field_honor_currency: UnitField.unit_end + 0x0469,
    player_field_arena_currency: UnitField.unit_end + 0x046a,
    player_field_max_level: UnitField.unit_end + 0x046b,
    player_field_daily_quests_1: UnitField.unit_end + 0x046c,
    player_rune_regen_1: UnitField.unit_end + 0x0485,
    player_rune_regen_2: UnitField.unit_end + 0x0486,
    player_rune_regen_3: UnitField.unit_end + 0x0487,
    player_rune_regen_4: UnitField.unit_end + 0x0488,
    player_no_reagent_cost_1: UnitField.unit_end + 0x0489,
    player_field_glyph_slots_1: UnitField.unit_end + 0x048c,
    player_field_glyph_slots_2: UnitField.unit_end + 0x048d,
    player_field_glyph_slots_3: UnitField.unit_end + 0x048e,
    player_field_glyph_slots_4: UnitField.unit_end + 0x048f,
    player_field_glyph_slots_5: UnitField.unit_end + 0x0490,
    player_field_glyph_slots_6: UnitField.unit_end + 0x0491,
    player_field_glyphs_1: UnitField.unit_end + 0x0492,
    player_field_glyphs_2: UnitField.unit_end + 0x0493,
    player_field_glyphs_3: UnitField.unit_end + 0x0494,
    player_field_glyphs_4: UnitField.unit_end + 0x0495,
    player_field_glyphs_5: UnitField.unit_end + 0x0496,
    player_field_glyphs_6: UnitField.unit_end + 0x0497,
    player_glyphs_enabled: UnitField.unit_end + 0x0498,
    player_pet_spell_power: UnitField.unit_end + 0x0499,
    player_end: UnitField.unit_end + 0x049a
}

export const GameObjectField = {
    gameobject_field_created_by: ObjectField.object_end + 0x0000,
    gameobject_displayid: ObjectField.object_end + 0x0002,
    gameobject_flags: ObjectField.object_end + 0x0003,
    gameobject_parentrotation: ObjectField.object_end + 0x0004,
    gameobject_dynamic: ObjectField.object_end + 0x0008,
    gameobject_faction: ObjectField.object_end + 0x0009,
    gameobject_level: ObjectField.object_end + 0x000a,
    gameobject_bytes_1: ObjectField.object_end + 0x000b,
    gameobject_end: ObjectField.object_end + 0x000c
}

export const DynamicObjectField = {
    dynamicobject_caster: ObjectField.object_end + 0x0000,
    dynamicobject_bytes: ObjectField.object_end + 0x0002,
    dynamicobject_spellid: ObjectField.object_end + 0x0003,
    dynamicobject_radius: ObjectField.object_end + 0x0004,
    dynamicobject_casttime: ObjectField.object_end + 0x0005,
    dynamicobject_end: ObjectField.object_end + 0x0006
}

export const CorpseField = {
  corpse_field_owner: ObjectField.object_end + 0x0000,
  corpse_field_party: ObjectField.object_end + 0x0002,
  corpse_field_display_id: ObjectField.object_end + 0x0004,
  corpse_field_item: ObjectField.object_end + 0x0005,
  corpse_field_bytes_1: ObjectField.object_end + 0x0018,
  corpse_field_bytes_2: ObjectField.object_end + 0x0019,
  corpse_field_guild: ObjectField.object_end + 0x001a,
  corpse_field_flags: ObjectField.object_end + 0x001b,
  corpse_field_dynamic_flags: ObjectField.object_end + 0x001c,
  corpse_field_pad: ObjectField.object_end + 0x001d,
  corpse_end: ObjectField.object_end + 0x001e
}

const groups: Map<ObjectType, any> = new Map()
groups.set(ObjectType.Object, ObjectField);
groups.set(ObjectType.Item, ItemField);
groups.set(ObjectType.Container, ContainerField);
groups.set(ObjectType.Unit, UnitField);
groups.set(ObjectType.Player, PlayerField);
groups.set(ObjectType.GameObject, GameObjectField);
groups.set(ObjectType.DynamicObject, DynamicObjectField);
groups.set(ObjectType.Corpse, CorpseField);

const allGroups = Object.entries(Array.from(groups.values()).reduce((obj, x) => {
  return {...obj, ...x}
}, {}));

export const getUpdateFieldName = (index: number, type: ObjectType) => {
  
  const gr = groups.get(type);
  if (gr) {
    const result = allGroups.find(([key, value]) => index === value);
    if (result) {
      return result[0];
    }
  }

  return index;
}