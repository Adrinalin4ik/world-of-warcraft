class GameOpcode {

  static CMSG_CHAR_ENUM                     = 0x0037;

  static SMSG_CHAR_ENUM                     = 0x003B;

  static CMSG_PLAYER_LOGIN                  = 0x003D;

  static SMSG_CHARACTER_LOGIN_FAILED        = 0x0041;
  static SMSG_LOGIN_SETTIMESPEED            = 0x0042;

  static SMSG_CONTACT_LIST                  = 0x0067;

  static CMSG_MESSAGE_CHAT                  = 0x0095;
  static SMSG_MESSAGE_CHAT                  = 0x0096;

  static SMSG_UPDATE_OBJECT                 = 0x00A9;

  static SMSG_MONSTER_MOVE                  = 0x00DD;

  static SMSG_TUTORIAL_FLAGS                = 0x00FD;

  static SMSG_INITIALIZE_FACTIONS           = 0x0122;

  static SMSG_SET_PROFICIENCY               = 0x0127;

  static SMSG_ACTION_BUTTONS                = 0x0129;
  static SMSG_INITIAL_SPELLS                = 0x012A;

  static SMSG_SPELL_START                   = 0x0131;
  static SMSG_SPELL_GO                      = 0x0132;

  static SMSG_BINDPOINT_UPDATE              = 0x0155;

  static SMSG_ITEM_TIME_UPDATE              = 0x01EA;

  static SMSG_AUTH_CHALLENGE                = 0x01EC;
  static CMSG_AUTH_PROOF                    = 0x01ED;
  static SMSG_AUTH_RESPONSE                 = 0x01EE;

  static SMSG_COMPRESSED_UPDATE_OBJECT      = 0x01F6;

  static SMSG_ACCOUNT_DATA_TIMES            = 0x0209;

  static SMSG_LOGIN_VERIFY_WORLD            = 0x0236;

  static SMSG_SPELL_NON_MELEE_DAMAGE_LOG    = 0x0250;

  static SMSG_INIT_WORLD_STATES             = 0x02C2;
  static SMSG_UPDATE_WORLD_STATE            = 0x02C3;

  static SMSG_WEATHER                       = 0x02F4;

  static MSG_SET_DUNGEON_DIFFICULTY         = 0x0329;

  static SMSG_UPDATE_INSTANCE_OWNERSHIP     = 0x032B;

  static SMSG_INSTANCE_DIFFICULTY           = 0x033B;

  static SMSG_MOTD                          = 0x033D;

  static SMSG_TIME_SYNC_REQ                 = 0x0390;

  static SMSG_FEATURE_SYSTEM_STATUS         = 0x03C9;

  static SMSG_SERVER_BUCK_DATA              = 0x041D;
  static SMSG_SEND_UNLEARN_SPELLS           = 0x041E;

  static SMSG_LEARNED_DANCE_MOVES           = 0x0455;

  static SMSG_ALL_ACHIEVEMENT_DATA          = 0x047D;

  static SMSG_POWER_UPDATE                  = 0x0480;

  static SMSG_AURA_UPDATE_ALL               = 0x0495;
  static SMSG_AURA_UPDATE                   = 0x0496;

  static SMSG_EQUIPMENT_SET_LIST            = 0x04BC;

  static SMSG_TALENTS_INFO                  = 0x04C0;

  static MSG_SET_RAID_DIFFICULTY            = 0x04EB;

  static CMSG_NAME_QUERY                    = 0x0050;
  static SMSG_NAME_QUERY_RESPONSE           = 0x0051;
  
  static CMSG_JOIN_CHANNEL                  = 0x0097;

  static SMSG_CHANNEL_NOTIFY                = 0x0099;

  static CMSG_PING                          = 0x01DC;
  static SMSG_PONG                          = 0x01DD;

  static SMSG_GM_MESSAGECHAT                = 0x03B3;

  // static SMSG_CHAR_DELETE = 0x278;
  // static SMSG_ADDON_INFO = 0xAF9;
  // static SMSG_ARENA_TEAM_CHANGE_FAILED_QUEUED = 0xB54;
  // static SMSG_COMPLAIN_RESULT = 0x2295;
  // static SMSG_REPORT_PVP_AFK_RESULT = 0x239D;
  // static SMSG_CHAT_RESTRICTED = 0x23BC;
  // static SMSG_CHAT_PLAYER_AMBIGUOUS = 0x2A94;
  // static MSG_TALENT_WIPE_CONFIRM = 0x2A95;
  // static CMSG_CHAR_CREATE = 0x2BF0;
  // static CMSG_AUTH_SESSION = 0x3000;
  // static SMSG_CHAR_ENUM = 0x429C;
  // static SMSG_PET_NAME_INVALID = 0x42D9;
  // static SMSG_FISH_ESCAPED = 0x431D;
  // static SMSG_MEETINGSTONE_MEMBER_ADDED = 0x43FD;
  // static SMSG_NEW_WORLD = 0x4A5D;
  // static SMSG_LOGOUT_RESPONSE = 0x63BC;
  // static SMSG_GMTICKET_SYSTEMSTATUS = 0x6A51;
  // static SMSG_PLAYERBOUND = 0x827D;
  // static SMSG_LOGOUT_COMPLETE = 0x8311;
  // static SMSG_ITEM_PUSH_RESULT = 0x835D;
  // static MSG_RANDOM_ROLL = 0x8A5D;
  // static CMSG_CHAR_DELETE = 0x8A78;
  // static SMSG_TOGGLE_XP_GAIN = 0x8AB8;
  // static SMSG_EXPLORATION_EXPERIENCE = 0x8B58;
  // static SMSG_PETGODMODE = 0x8B99;
  // static SMSG_NEW_TAXI_PATH = 0xA259;
  // static SMSG_LOGOUT_CANCEL_ACK = 0xA395;
  // static SMSG_CHAR_CREATE = 0xC211;
  // static SMSG_PLAYERBINDERROR = 0xC3FC;
  // static SMSG_FISH_NOT_HOOKED = 0xCAB5;
  // static SMSG_LEVELUP_INFO = 0xCB15;
  // static SMSG_CHARACTER_LOGIN_FAILED = 0xCBD9;
  // static SMSG_CLIENTCACHE_VERSION = 0xE2B8;
  // static SMSG_CHAT_WRONG_FACTION = 0xE2D4;
  // static SMSG_AUTH_RESPONSE = 0xEB58;
  // static SMSG_AUTH_CHALLENGE = 0x8500;
  // static CMSG_CHAR_ENUM = 0x3F8;
  // static SMSG_CREATURE_QUERY_RESPONSE = 0x83B8;
  // static SMSG_TRIGGER_CINEMATIC = 0x6310;
  // static SMSG_SET_PROFICIENCY = 0x22D4;
  // static SMSG_BINDPOINTUPDATE = 0xA255;
  // static SMSG_CALENDAR_EVENT_INVITE = 0xE2FC;
  // static SMSG_UPDATE_OBJECT = 0x8BF0;
  // static SMSG_REALM_SPLIT = 0x4270;
  // static CMSG_REALM_SPLIT = 0xAB58;
  // static CMSG_CHAR_CUSTOMIZE = 0x250;
  // static SMSG_CHAR_CUSTOMIZE = 0xE2B5;
  // static CMSG_READY_FOR_ACCOUNT_DATA_TIMES = 0x6A99;
  // static CMSG_PING = 0x1001;
  // static SMSG_ACCOUNT_DATA_TIMES = 0x82B5;
  // static CMSG_CHAR_RENAME = 0xAB38;
  // static SMSG_CHAR_RENAME = 0xA33C;
  // static CMSG_REDIRECT_ERROR = 0x1080;
  // static CMSG_REDIRECT_UNK = 0x1201;
  // static CMSG_REDIRECT_AUTH_PROOF = 0x3081;
  // static CMSG_REDIRECT_TOKEN_UNK = 0x3001;
  // static SMSG_PONG = 0xC500;
  // static SMSG_REDIRECT_CLIENT = 0x8400;
  // static SMSG_REDIRECT_SEND_QUEUED_PACKETS = 0x4400;
  // static SMSG_COMPRESSED_UPDATE_OBJECT = 0xCB74;
  // static SMSG_LOGIN_SETTIMESPEED = 0x0A10;
  // static CMSG_PLAYER_LOGIN = 0x1621;
  // static CMSG_NAME_QUERY = 0x4354;
  // static SMSG_NAME_QUERY_RESPONSE = 0x0A14;
  // static CMSG_CREATURE_QUERY = 0xE3D5;
  // static CMSG_CONTACT_LIST = 0x63D4;
  // static SMSG_CONTACT_LIST = 0x439C;
  // static SMSG_FRIEND_STATUS = 0xBF16;
  // static CMSG_ADD_FRIEND = 0xCAB1;
  // static CMSG_MESSAGECHAT = 0xFFFF;
  // static CMSG_CHAT_MSG_SAY = 0x5200;
  // static CMSG_CHAT_MSG_YELL = 0x7200;
  // static SMSG_MESSAGECHAT = 0xBD0;
  // static SMSG_DESTROY_OBJECT = 0xE310;
  // static MSG_MOVE_START_FORWARD = 0x0B31;
  // static MSG_MOVE_START_BACKWARD = 0x0B50;
  // static MSG_MOVE_STOP = 0x433C;
  // static MSG_MOVE_START_STRAFE_LEFT = 0xE395;
  // static MSG_MOVE_START_STRAFE_RIGHT = 0x6BF4;
  // static MSG_MOVE_STOP_STRAFE = 0xA31C;
  // static MSG_MOVE_JUMP = 0x0A39;
  // static MSG_MOVE_START_TURN_LEFT = 0xAA90;
  // static MSG_MOVE_START_TURN_RIGHT = 0x4BFC;
  // static MSG_MOVE_STOP_TURN = 0xC39D;
  // static MSG_MOVE_SET_RUN_MODE = 0xE339;
  // static MSG_MOVE_SET_WALK_MODE = 0x8A74;
  // static MSG_MOVE_FALL_LAND = 0xAA58;
  // static MSG_MOVE_HEARTBEAT = 0xB38;
  // static SMSG_ACTION_BUTTONS = 0xEB74;
  // static SMSG_INITIAL_SPELLS = 0xC2B0;
  // static SMSG_LEARNED_SPELL = 0xCAFC;
  // static CMSG_PLAYED_TIME = 0x8355;
  // static SMSG_PLAYED_TIME = 0x6BF8;
  // static CMSG_UPDATE_ACCOUNT_DATA = 0xEB55;
  // static SMSG_PLAY_SOUND = 0xA2D1;
  // static SMSG_MOTD = 0x4394;
  // static SMSG_TIME_SYNC_REQ = 0xA318;
  // static SMSG_LFG_BOOT_PLAYER = 0x8399;
  // static SMSG_CHANNEL_NOTIFY = 0x6358;
  // static SMSG_CHANNEL_LIST = 0xA5D;
  // static SMSG_TEXT_EMOTE = 0x83D8;
  // static SMSG_ZONE_UNDER_ATTACK = 0x6215;
  // static SMSG_DEFENSE_MESSAGE = 0xA27C;
  // static SMSG_SERVER_MESSAGE = 0x221C;
  // static SMSG_RAID_INSTANCE_MESSAGE = 0xEB78;
  // static SMSG_INSTANCE_RESET = 0x2B34;
  // static SMSG_INSTANCE_RESET_FAILED = 0xCAB8;
  // static SMSG_UPDATE_LAST_INSTANCE = 0x2B91;
  // static SMSG_UPDATE_INSTANCE_OWNERSHIP = 0xCB5D;
  // static SMSG_EXPTECTED_SPAM_RECORDS = 0xABDD;
  // static SMSG_TITLE_EARNED = 0xB91;
  // static SMSG_RESET_FAILED_NOTIFY = 0xA258;
  // static SMSG_GM_MESSAGECHAT = 0xE3B0;
  // static SMSG_XP_GAIN = 0xC3BC;
  // static SMSG_DURABILITY_DAMAGE_DEATH = 0xBF0;
  // static SMSG_CHANNEL_MEMBER_COUNT = 0xAAB1;
  // static SMSG_COMSAT_RECONNECT_TRY = 0x63F8;
  // static SMSG_COMSAT_DISCONNECT = 0xCB71;
  // static SMSG_COMSAT_CONNECTION_FAILED = 0x4B59;
  // static SMSG_VOIC_CHAT_STATUS = 0x627D;
  // static SMSG_USERLIST_ADD = 0xC2FC;
  // static SMSG_USERLIST_REMOVE = 0xCBB9;
  // static SMSG_USERLIST_UPDATE = 0xAA5C;
  // static SMSG_COMSAT_VOICE_SESSION_FULL = 0xCB90;
  // static SMSG_SERVER_FIRST_ACHIEVEMENT = 0xCA10;
  // static SMSG_NOTIFICATION = 0xA31;
  // static SMSG_TRANSFER_PENDING = 0x6210;
  // static SMSG_TRANSFER_ABORTED = 0xB55;
  // static SMSG_KICK_REASON = 0x4A71;
  // static SMSG_START_MIRROR_TIMER = 0x6A54;
  // static SMSG_PAUSE_MIRROR_TIMER = 0xA55;
  // static SMSG_STOP_MIRROR_TIMER = 0x2299;
  // static SMSG_GROUP_JOINED_BATTLEGROUND = 0x18;
  // static SMSG_MAIL_SEND_RESULT = 0xE351;
  // static SMSG_MAIL_LIST_RESULT = 0xABD1;
  // static MSG_QUERY_NEXT_MAIL_TIME = 0xA51;
  // static SMSG_RECEIVED_MAIL = 0x4A54;
  // static SMSG_MEETINGSTONE_COMPLETE = 0xEA14;
  // static MSG_RAID_TARGET_UPDATE = 0xB74;
  // static MSG_RAID_READY_CHECK = 0x82D0;
  // static MSG_RAID_READY_CHECK_CONFIRM = 0x2250;
  // static MSG_RAID_READY_CHECK_FINISHED = 0x82D5;
  // static SMSG_RAID_READY_CHECK_ERROR = 0xCB50;
  // static MSG_NOTIFY_PARTY_SQUELCH = 0xC39C;
  // static SMSG_ECHO_PARTY_SQUELCH = 0xA3DD;
  // static SMSG_PLAY_DANCE = 0x8BBD;
  // static SMSG_STOP_DANCE = 0xCA50;
  // static SMSG_NOTIFY_DANCE = 0x223D;
  // static SMSG_LEARNED_DANCE_MOVES = 0x22D5;
  // static SMSG_GOSSIP_MESSAGE = 0xAB3D;
  // static SMSG_GOSSIP_COMPLETE = 0x6BF9;
  // static SMSG_GOSSIP_POI = 0xBD9;
  // static MSG_AUCTION_HELLO = 0x8371;
  // static SMSG_AUCTION_COMMAND_RESULT = 0xAB5D;
  // static SMSG_AUCTION_LIST_RESULT = 0x827C;
  // static SMSG_AUCTION_OWNER_LIST_RESULT = 0x4B94;
  // static SMSG_AUCTION_BIDDER_LIST_RESULT = 0x42D5;
  // static SMSG_AUCTION_BIDDER_NOTIFICATION = 0x4250;
  // static SMSG_AUCTION_OWNER_NOTIFICATION = 0x42B5;
  // static SMSG_AUCTION_REMOVED_NOTIFICATION = 0x4379;
  // static SMSG_AUCTION_LIST_PENDING_SALES = 0xE2F9;
  // static SMSG_PET_SPELLS = 0x63F1;
  // static SMSG_PET_LEARNED_SPELL = 0xEA71;
  // static SMSG_PET_UNLEARNED_SPELL = 0x2ABD;
  // static SMSG_PET_MODE = 0x6219;
  // static SMSG_PET_ACTION_FEEDBACK = 0x370;
  // static SMSG_PET_BROKEN = 0x6A71;
  // static SMSG_PET_RENAMEABLE = 0x22F8;
  // static SMSG_PET_UPDATE_COMBO_POINTS = 0x8BF5;
  // static SMSG_PET_GUIDS = 0x3F0;
  // static SMSG_GAMEOBJECT_QUERY_RESPONSE = 0x231;
  // static SMSG_NPC_TEXT_UPDATE = 0x8310;
  // static SMSG_GUILD_QUERY_RESPONSE = 0xEA1D;
  // static SMSG_QUEST_QUERY_RESPONSE = 0x2AD4;
  // static SMSG_PAGE_TEXT_QUERY_RESPONSE = 0x8A58;
  // static SMSG_PET_NAME_QUERY_RESPONSE = 0xB1C;
  // static SMSG_PETITION_QUERY_RESPONSE = 0x2A7D;
  // static SMSG_ITEM_TEXT_QUERY_RESPONSE = 0x8210;
  // static SMSG_INVALIDATE_PLAYER = 0xAAD5;
  // static SMSG_ARENA_TEAM_QUERY_RESPONSE = 0x23B0;
  // static SMSG_INVALIDATE_DANCE = 0x233C;
  // static SMSG_EMOTE = 0x2B98;
}

export default GameOpcode;


