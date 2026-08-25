/**
 * ONE PLACE where a FrameXML unit TOKEN becomes an ENTITY.
 *
 * ## Why this file exists rather than another arm in a ternary
 *
 * `world-ui.ts#subjectForUnit` resolved exactly two tokens -- `"player"` and `"target"` -- so the NPC
 * portrait was blank in every window that talks to one: "Не вижу портрета тренера в окне. Впрочем,
 * проблема общая, при общении с НИП нет портрета." The client is asking correctly
 * (`merchantframe.lua:74` calls `SetPortraitTexture(MerchantFramePortrait, "NPC")`, and
 * `blizzard_trainerui.lua:75` and `gossipframe.lua` do the same for their own frames); we answered
 * nothing.
 *
 * It is a separate module and not a third arm because the two sides need DIFFERENT things and a
 * conditional cannot bridge them. The bridges push a `UnitSnapshot`, which by deliberate design
 * "contains no world, no network and NO GUIDS" (`framexml/lua/api/units.ts:11`) -- it carries a name
 * and numbers, and nothing that could find a body. The booth needs a real `Unit`, because a portrait is
 * baked from `characterLook` or `creatureDisplay`. So the question is token-to-ENTITY resolution, which
 * belongs to the world, and answering it in one function is what stops the next frame that names a unit
 * from needing another arm.
 *
 * ## Where the NPC comes from, and why nothing has to be written anywhere
 *
 * The three handlers that open an NPC window already keep the guid the PACKET carried:
 * `GossipHandler.source`, `MerchantHandler.source` and `TrainerHandler.source` are each `public source:
 * string | null`, set from the opening packet and nulled on close. So the `"npc"` token resolves by
 * READING them -- no registry to keep in step, no writer to add to a bridge, and nothing that can go
 * stale, because the same handler that set the guid clears it. It is also the RIGHT guid rather than a
 * proxy: it is the one the server named, not "the last unit we clicked".
 *
 * ## Which tokens the manifest actually asks with -- read, not guessed
 *
 * Every `SetPortraitTexture` call in the shipped 3.3.5a FrameXML, grepped from the game's own files
 * rather than assumed, uses one of exactly three things:
 *
 *  - **`"npc"` / `"NPC"`** -- `gossipframe.lua`, `merchantframe.lua`, `bankframe.lua`,
 *    `tabardframe.lua`, `taxiframe.lua`, `guildregistrarframe.lua` (the case is inconsistent across
 *    those files, which is why this module lowercases);
 *  - **`"questnpc"`** -- `questframe.lua:65`, and it is the ONLY file that uses it;
 *  - **`self.unit`** -- `unitframe.lua:97`, i.e. whatever unit the frame was initialised with:
 *    `player`, `target`, `pet`, `focus`, party and raid tokens.
 *
 * So the set below is complete for portraits as the client ships them. The `npc` askers this client has
 * no handler for -- bank, tabard, taxi, guild registrar -- resolve through the same three window guids
 * as everything else, which for them is null: those features do not exist here, so their frames never
 * open and their portraits are never asked for.
 *
 * ## Case
 *
 * Tokens are lowercased here. The client's own files use BOTH spellings for the same unit --
 * `MerchantFrame_UpdateMerchantInfo` does `UnitName("NPC")` while `GossipFrameUpdate` does
 * `UnitName("npc")` -- because the real engine's tokens are case-insensitive. `api/units.ts#withUnit`
 * still resolves through an exact-match `Map`, which is why the bridges register both spellings; this
 * side needs no such duplication and does not want the trap.
 */
import type Unit from '../classes/unit';

/**
 * The world this resolves against -- structurally, so this module needs no import of `World` and
 * `World` needs no import of this beyond the call.
 */
export interface TokenWorld {
  player: Unit | null;
  target: Unit | null;
  entities: Map<string, Unit>;
  hovered?: Unit | null;
  /**
   * The focused entity, or null. Written by `ui/group-bridge.ts#FocusUnit` -- the one site that knows
   * it, because `focus` is set from ANOTHER TOKEN's snapshot and a snapshot carries no guid by design.
   * Shaped exactly like `hovered` above for the same reason: the world holds it, this file reads it.
   */
  focus?: Unit | null;
  game?: {
    objectHandler?: {
      gossipHandler?: { source: string | null };
      merchantHandler?: { source: string | null };
      trainerHandler?: { source: string | null };
      questHandler?: { source: string | null };
      /**
       * THE GROUP ROSTER, and it is the only place a party member's guid exists.
       *
       * `ui/group-bridge.ts` publishes party tokens as UI SNAPSHOTS -- name, health, class -- which
       * is what the party frames need and carries no position and no guid by design. So a caller who
       * wants the member as a `Unit` (the minimap blips, the world map dots) cannot go through the
       * snapshot store and has to come here.
       */
      groupHandler?: { members: { guid: string }[] };
    };
  };
}

/**
 * The guid of the NPC whose window is open, or null.
 *
 * GOSSIP IS LAST, and that is the whole ordering rule. A quest page, a trainer list and a vendor list
 * are each normally reached THROUGH a gossip menu, so gossip may still be holding the same guid -- in
 * which case they agree -- and where they could disagree, the more specific panel is the one on screen.
 * Each handler nulls its own `source` when its window closes, which is what makes this self-clearing.
 *
 * THE QUEST GIVER WAS THE MISSING ONE, and its absence was the owner's second report: the portrait
 * appeared on the gossip page and vanished the moment he clicked a quest row. The quest frame takes
 * over, `GossipHandler` clears its own `source`, and the giver's guid lives in
 * `QuestHandler.source` -- "The giver whose panel is open" (`network/game/object/quest.ts:262-263`),
 * public, set from the giver packets and cleared with the panels -- which nothing here was reading.
 *
 * Among the three SPECIFIC panels the order is ARBITRARY, and this says so rather than pretending to be
 * derived: only one of them can be on screen at a time, because the client's own `ShowUIPanel` closes
 * the others, so two of these fields holding DIFFERENT guids at once is not a state the UI can reach.
 * Quest is first because it is the deepest in the flow the defect came from.
 */
function npcGuid(world: TokenWorld): string | null {
  const handlers = world.game?.objectHandler;
  return handlers?.questHandler?.source
    ?? handlers?.trainerHandler?.source
    ?? handlers?.merchantHandler?.source
    ?? handlers?.gossipHandler?.source
    ?? null;
}

/** The entity a guid names, or null for a null guid and for a guid no longer in the grid. */
function entityFor(world: TokenWorld, guid: string | null): Unit | null {
  return guid === null ? null : world.entities.get(guid) ?? null;
}

/**
 * Resolve one unit token to the entity behind it, or null.
 *
 * Null is a first-class answer and the caller must treat it as "draw nothing" -- never as a body with
 * no look. `model-booth.ts` already gates its opaque portrait backdrop on there being a figure for
 * exactly this reason, so a token that resolves to nothing leaves a transparent pane rather than a
 * black disc.
 *
 * WHAT IS NOT HERE, named rather than silently answered:
 *
 *  - **`focus` IS ANSWERED NOW**, and the call this comment asked for exists: `FocusUnit` resolves the
 *    token it is given to an entity and stores it on `World#focus`, which is read below. It is set from
 *    another token's snapshot and a snapshot carries no guid, so that site is the only one that can
 *    know it. **The LIVE entity, not a frozen one, and that is the client's own behaviour rather than
 *    our choice**: `FocusFrame` inherits `TargetFrameTemplate`, whose `OnLoad` registers `UNIT_HEALTH`,
 *    `UNIT_LEVEL`, `UNIT_FACTION`, `UNIT_AURA` and `UNIT_CLASSIFICATION_CHANGED`
 *    (`targetframe.lua:63-78`), plus three more on `FocusFrame` itself (`:1045-1047`) -- so the real
 *    client's focus frame tracks its unit as it changes.
 *  - **`pet`, `party1..4`, `raid*`, `targettarget`.** `api/units.ts` records that this client does not
 *    track them at all, so there is no entity to find. The pet pane is on the same list.
 *  - **`mouseover`.** Answered, because the hover pick already resolves it for the cursor and the
 *    model brighten (`world/hover-highlight.ts`) -- `World` exposes it as `hovered`. The client's own
 *    `mouseover` token is that same unit, so this costs nothing and is not a guess.
 */
export function resolveUnitToken(token: string, world: TokenWorld | null): Unit | null {
  if (world === null || typeof token !== 'string') {
    return null;
  }
  switch (token.toLowerCase()) {
    case 'player':
      return world.player ?? null;
    case 'target':
      return world.target ?? null;
    case 'mouseover':
      return world.hovered ?? null;
    case 'focus':
      return world.focus ?? null;
    case 'npc':
      return entityFor(world, npcGuid(world));
    // THE QUEST GIVER, AND IT IS ITS OWN TOKEN. `QuestFrame_SetPortrait` asks with `"questnpc"`, not
    // `"npc"` -- `SetPortraitTexture(QuestFramePortrait, "questnpc")`, the game's own
    // `questframe.lua:62-68` -- so the quest detail page had no portrait while gossip, merchant and
    // trainer all had one. That was the owner's report twice over, and the round that added
    // `QuestHandler.source` to the `npc` chain did not fix it because the quest frame never asks that
    // token. Read straight from the quest handler rather than through `npcGuid`: `"questnpc"` MEANS
    // the giver, so falling back to a vendor or a trainer guid would be answering a different
    // question.
    case 'questnpc':
      return entityFor(world, world.game?.objectHandler?.questHandler?.source ?? null);
    default:
      return groupMember(token.toLowerCase(), world);
  }
}

/**
 * `party1..4` and `raid1..40` -> the member's `Unit`, or null.
 *
 * **THESE WERE MISSING ENTIRELY, and two features were silently inert because of it.** The world
 * map's party dots and the minimap's group blips both call this resolver, and both got null for every
 * token -- the owner saw no group anywhere and the probe read `group: 0` in a real party. Nothing
 * errored: an absent case in a `switch` returns null, which is indistinguishable from "that member
 * is out of range".
 *
 * The ORDER is `SMSG_GROUP_LIST`'s, which is the order `ui/group-bridge.ts` already publishes the
 * snapshots in and the order `PartyMemberFrame<N>` expects (`partymemberframe.lua:83`). Both indexes
 * read the same roster, so a member cannot be `party2` to one caller and `party3` to another.
 *
 * A member with no ENTITY answers null, and that is correct rather than a gap: the roster carries a
 * member who is out of visual range, but this function's contract is a `Unit` -- something with a
 * position and a model. A caller that only needs the name uses the snapshot store, which is exactly
 * why the two live apart.
 *
 * `raid` is the SAME roster and not a separate one. 3.3.5a keeps one member list either way and the
 * group type is a flag on it (`network/game/object/group.ts:86`), so `raid1` and `party1` name the
 * same person in a five-man -- which is what the real client does.
 */
function groupMember(token: string, world: TokenWorld): Unit | null {
  const match = /^(party|raid)([0-9]{1,2})$/.exec(token);
  if (match === null) {
    return null;
  }
  const index = Number(match[2]);
  const members = world.game?.objectHandler?.groupHandler?.members ?? [];
  const member = index >= 1 ? members[index - 1] : undefined;
  return member === undefined ? null : entityFor(world, member.guid);
}
