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
  game?: {
    objectHandler?: {
      gossipHandler?: { source: string | null };
      merchantHandler?: { source: string | null };
      trainerHandler?: { source: string | null };
    };
  };
}

/**
 * The guid of the NPC whose window is open, or null.
 *
 * ORDER IS DELIBERATE and it is the order a window can shadow another: a trainer or a vendor is
 * normally reached THROUGH a gossip menu, so while the trainer list is up the gossip handler may still
 * be holding the same guid -- they agree, and asking gossip first is therefore harmless. Where they
 * could disagree, the more specific window is the one on screen, so it wins. Each handler nulls its own
 * `source` when its window closes, which is what makes this self-clearing.
 */
function npcGuid(world: TokenWorld): string | null {
  const handlers = world.game?.objectHandler;
  return handlers?.trainerHandler?.source
    ?? handlers?.merchantHandler?.source
    ?? handlers?.gossipHandler?.source
    ?? null;
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
 *  - **`focus`.** It is a pure client concept with no packet (`ui/group-bridge.ts:665`) and it is set
 *    from ANOTHER TOKEN's snapshot, so the entity behind it is only known at the moment
 *    `SetFocus` runs. Resolving it needs one call from that site -- `world.aliasUnitToken('focus',
 *    token)` or equivalent -- and that file belongs to another agent this round. Until then a
 *    `FocusFrame` portrait resolves to nothing and draws nothing.
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
    case 'npc': {
      const guid = npcGuid(world);
      return guid === null ? null : world.entities.get(guid) ?? null;
    }
    default:
      return null;
  }
}
