/**
 * Token-to-entity resolution: the NPC portrait's whole defect was that `"NPC"` resolved to nothing.
 *
 * One test, on the three things a screenshot cannot attribute -- which handler the guid comes from,
 * that the two spellings the client's own files use both work, and that an unknown token answers null
 * rather than something.
 */
import { resolveUnitToken } from '../unit-tokens';

function world(source: {
  gossip?: string | null; merchant?: string | null; trainer?: string | null; quest?: string | null;
}) {
  const npc = { name: 'Llane Beshere' } as never;
  const player = { name: 'Gesf' } as never;
  const wolf = { name: 'Mangy Wolf' } as never;
  return {
    world: {
      player,
      target: wolf,
      hovered: null,
      focus: null,
      entities: new Map<string, never>([['0xF130000123', npc]]),
      game: {
        objectHandler: {
          gossipHandler: { source: source.gossip ?? null },
          merchantHandler: { source: source.merchant ?? null },
          trainerHandler: { source: source.trainer ?? null },
          questHandler: { source: source.quest ?? null },
        },
      },
    },
    npc,
    player,
    wolf,
  };
}

describe('resolving a FrameXML unit token to an entity', () => {
  it('answers the NPC from whichever window is open, under both spellings', () => {
    const open = world({ trainer: '0xF130000123' });
    // `blizzard_trainerui.lua:75` asks with "npc"; `merchantframe.lua:74` asks with "NPC". The real
    // engine's tokens are case-insensitive and both must land on the same body.
    expect(resolveUnitToken('npc', open.world)).toBe(open.npc);
    expect(resolveUnitToken('NPC', open.world)).toBe(open.npc);

    // The guid comes from the PACKET the handler recorded, so a vendor works the same way...
    const shop = world({ merchant: '0xF130000123' });
    expect(resolveUnitToken('NPC', shop.world)).toBe(shop.npc);
    // ...and so does a plain gossip menu.
    const chat = world({ gossip: '0xF130000123' });
    expect(resolveUnitToken('npc', chat.world)).toBe(chat.npc);

    // THE QUEST DETAIL PAGE, and it is its OWN TOKEN: `questframe.lua:65` asks with `"questnpc"`, not
    // `"npc"`. Adding the quest handler to the `npc` chain (commit 6b7b7d4) therefore did not fix the
    // missing portrait, because the quest frame never asks that token. This is the arm that does.
    const giver = world({ quest: '0xF130000123' });
    expect(resolveUnitToken('questnpc', giver.world)).toBe(giver.npc);
    expect(resolveUnitToken('QUESTNPC', giver.world)).toBe(giver.npc);
    // `questnpc` MEANS the giver, so it does not fall back to a vendor's or a trainer's guid.
    expect(resolveUnitToken('questnpc', world({ merchant: '0xF130000123' }).world)).toBeNull();
    expect(resolveUnitToken('questnpc', world({ trainer: '0xF130000123' }).world)).toBeNull();

    // THE QUEST GIVER ON THE `npc` CHAIN, which was the owner's second report: the portrait showed on the gossip
    // page and vanished when he clicked a quest row, because the quest frame takes over, gossip clears
    // its own `source`, and the giver's guid lives in `QuestHandler.source`.
    const quest = world({ quest: '0xF130000123' });
    expect(resolveUnitToken('npc', quest.world)).toBe(quest.npc);
    // And the handover itself: gossip has closed, the quest page is up, and the portrait survives.
    const handover = world({ gossip: null, quest: '0xF130000123' });
    expect(resolveUnitToken('NPC', handover.world)).toBe(handover.npc);

    // Every window closed: each handler nulls its own `source`, so this self-clears.
    expect(resolveUnitToken('npc', world({}).world)).toBeNull();
    // A guid with no entity in the grid is null, not a body with no look.
    expect(resolveUnitToken('npc', world({ gossip: '0xDEAD' }).world)).toBeNull();

    // The two that already worked still do, and a token this client does not track answers null so
    // the pane draws nothing rather than a black disc.
    expect(resolveUnitToken('player', open.world)).toBe(open.player);
    expect(resolveUnitToken('target', open.world)).toBe(open.wolf);
    // `focus` has a real producer now -- `World#focus` holds the entity, written by group-bridge's
    // `FocusUnit`/`ClearFocus` -- so it resolves when one is set and nulls when it is not.
    expect(resolveUnitToken('focus', open.world)).toBeNull();
    expect(resolveUnitToken('focus', { ...open.world, focus: open.npc })).toBe(open.npc);
    expect(resolveUnitToken('party1', open.world)).toBeNull();
    expect(resolveUnitToken('npc', null)).toBeNull();
  });
});
