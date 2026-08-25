/**
 * THE CHAT COLOUR TABLE -- and it belongs to the ENGINE, not to FrameXML.
 *
 * This is the whole of "цвета в чате не те", and reading `chatframe.lua` is what settles where it has
 * to live. Every entry the client declares carries no colour at all:
 *
 *     ChatTypeInfo["SAY"] = { sticky = 1, flashTab = false, flashTabOnGeneral = false };
 *
 * (`chatframe.lua:34-106`, 73 entries, not one `r`). The `r`/`g`/`b` fields arrive later and from
 * outside, through one event arm:
 *
 *     if ( event == "UPDATE_CHAT_COLOR" ) then
 *         local info = ChatTypeInfo[strupper(arg1)];
 *         if ( info ) then info.r = arg2; info.g = arg3; info.b = arg4; ...
 *
 * (`:2516-2532`). So a client that is never told the colours renders every line with `info.r` nil, and
 * `ChatFrame_MessageEventHandler`'s `self:AddMessage(text, info.r, info.g, info.b, info.id)` (`:2568`)
 * passes three nils into `AddMessage`, which keeps the region's authored font colour -- white. That is
 * exactly what the owner saw, and no amount of looking at the message frame would have shown it.
 *
 * `chat-bridge.ts` fired `UPDATE_CHAT_COLOR` once with NO ARGUMENTS, which reaches that arm with
 * `arg1` nil and does nothing. One event PER TYPE is what the engine does and what this table feeds.
 *
 * ## Where the numbers come from
 *
 * The reference's own table: `samples/benilla/crates/benilla-app/src/ui_chat/event.rs:439-472`
 * (`default_color`), whose docstring cites "the complete shipped table (chat-cache COLORS = wow-re
 * `chat-color-table.md`)" and names the client function that seeds it, `0x4982c0`, with
 * `ResetChatColors 0x4a09e0` re-doing the same. They are stored here as bytes, the way that table
 * states them, and divided by 255 at the point of use -- so a value can be compared with the reference
 * by eye rather than through arithmetic.
 *
 * **benilla is 1.12 and this client is 3.3.5a, so per the project rule this table is authoritative on
 * MECHANISM and each VALUE is a version-numbered claim.** Every colour the owner named independently
 * agrees with it, which is the only check available without the 3.3.5a binary: party blue `AAAAFF`,
 * whisper pink `FF80FF`, raid orange `FF7F00`, yell red `FF4040`, system yellow `FFFF00`, say white,
 * channels brown-pink. The four entries most likely to have MOVED between the two versions are the
 * leader/warning family, which 3.3.5a split further than 1.12 did (`RAID_LEADER`, `RAID_WARNING`,
 * `BATTLEGROUND_LEADER`, and `PARTY_LEADER`, which 1.12 does not have at all); they are flagged below.
 *
 * ## What is NOT here
 *
 * A CVar. The real engine reads `Color_<type>` and `ChangeChatColor` writes it back, which is why
 * `api/chat.ts` declares `ChangeChatColor` a gap: nothing persists. So this is the FRESH-INSTALL table
 * -- the colours a player who has never touched the chat options sees -- and a change made in the
 * options window will not survive a reload. Stated rather than implied.
 */

/** One row: the `ChatTypeInfo` key, then r, g, b as 0..255 bytes. */
export type ChatColour = readonly [string, number, number, number];

/**
 * The shipped table, ported row for row from `event.rs:439-472`.
 *
 * ORDER IS IRRELEVANT to the client -- each row becomes its own `UPDATE_CHAT_COLOR` -- so the rows are
 * grouped the way the reference groups them, which makes a line-by-line comparison possible.
 */
export const CHAT_COLOURS: ReadonlyArray<ChatColour> = [
  // The player-to-player types the owner named.
  ['SAY', 255, 255, 255],
  ['PARTY', 170, 170, 255],
  ['RAID', 255, 127, 0],
  ['GUILD', 64, 255, 64],
  ['OFFICER', 64, 192, 64],
  ['YELL', 255, 64, 64],
  ['WHISPER', 255, 128, 255],
  ['WHISPER_INFORM', 255, 128, 255],
  // `REPLY` shares WHISPER's row, and the client MIRRORS it by hand in the same event arm
  // (`chatframe.lua:2524-2532`) -- so it is seeded here too rather than relying on that mirror, which
  // only runs when a WHISPER event is what arrived.
  ['REPLY', 255, 128, 255],
  ['AFK', 255, 128, 255],
  ['DND', 255, 128, 255],
  ['EMOTE', 255, 128, 64],
  ['TEXT_EMOTE', 255, 128, 64],
  ['SYSTEM', 255, 255, 0],

  // Creatures.
  ['MONSTER_SAY', 255, 255, 159],
  ['MONSTER_YELL', 255, 64, 64],
  ['MONSTER_EMOTE', 255, 128, 64],
  ['MONSTER_WHISPER', 179, 179, 179],
  ['RAID_BOSS_EMOTE', 255, 219, 183],

  // Channels. `CHANNEL` is the row every numbered channel starts from -- see `CHANNEL1..10` below.
  ['CHANNEL', 255, 192, 192],
  ['CHANNEL_JOIN', 192, 128, 128],
  ['CHANNEL_LEAVE', 192, 128, 128],
  ['CHANNEL_LIST', 192, 128, 128],
  ['CHANNEL_NOTICE', 192, 192, 192],
  ['CHANNEL_NOTICE_USER', 192, 192, 192],

  // Feedback.
  ['IGNORED', 255, 0, 0],
  ['SKILL', 85, 85, 255],
  ['LOOT', 0, 170, 0],
  ['MONEY', 255, 255, 0],
  ['COMBAT_XP_GAIN', 111, 111, 255],
  ['COMBAT_HONOR_GAIN', 224, 202, 10],

  // Battleground system lines.
  ['BG_SYSTEM_NEUTRAL', 255, 120, 10],
  ['BG_SYSTEM_ALLIANCE', 0, 174, 239],
  ['BG_SYSTEM_HORDE', 255, 0, 0],
  ['BATTLEGROUND', 255, 127, 0],

  /**
   * THE LEADER/WARNING FAMILY -- the rows whose 3.3.5a values are least certain.
   *
   * The reference gives `RaidLeader | RaidWarning | RaidBossEmote | BattlegroundLeader` one shared row,
   * `FFDBB7` (`event.rs:464-466`). 3.3.5a declares them as four separate `ChatTypeInfo` keys
   * (`chatframe.lua:74-80`) and adds `PARTY_LEADER` (`:94`), which 1.12 has no concept of -- a raid
   * warning in this client is visibly a harder orange-red than a boss emote, so at least one of these
   * moved. Kept at the reference's value rather than invented, and named here so the disagreement is
   * on the record instead of being discovered as a wrong colour later.
   *
   * `PARTY_LEADER` takes PARTY's row for the same reason `REPLY` takes WHISPER's: a leader line is a
   * party line, and the alternative is a hue nothing states.
   */
  ['RAID_LEADER', 255, 219, 183],
  ['RAID_WARNING', 255, 219, 183],
  ['BATTLEGROUND_LEADER', 255, 219, 183],
  ['PARTY_LEADER', 170, 170, 255],
];

/**
 * `CHANNEL1`..`CHANNEL10`, every one seeded from the live `CHANNEL` row.
 *
 * Not a guess and not padding: the reference states that the boot seed creates ten EXTRA registry
 * entries and colours all of them from the CHANNEL entry, so they all start at its `FFC0C0`
 * (`event.rs:474-479`, citing the same `0x4982c0`). `chatframe.lua:82-91` declares exactly ten such
 * keys, so the two agree on the count.
 *
 * They matter because `ChatFrame_MessageEventHandler` looks up a channel message by its NUMBER
 * (`ChatTypeInfo["CHANNEL"..arg8]`), not by the bare `CHANNEL` key -- so seeding `CHANNEL` alone would
 * leave every General or Trade line uncoloured.
 */
export const NUMBERED_CHANNELS = 10;

/** Every row the engine should announce, numbered channels included. */
export function chatColourEvents(): ChatColour[] {
  const out = CHAT_COLOURS.map((row) => row as ChatColour);
  const channel = CHAT_COLOURS.find(([name]) => name === 'CHANNEL');
  if (channel !== undefined) {
    for (let n = 1; n <= NUMBERED_CHANNELS; n += 1) {
      out.push([`CHANNEL${n}`, channel[1], channel[2], channel[3]]);
    }
  }
  return out;
}
