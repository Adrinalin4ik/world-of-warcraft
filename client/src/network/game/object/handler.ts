import EventEmitter from 'events';
import { CombatHandler } from './combat';
import { CombatLogHandler } from './combat-log';
import { GameHandler } from '../handler';
import { ItemHandler } from './items';
import { LootHandler } from './loot';
import { GossipHandler } from './gossip';
import { MerchantHandler } from './merchant';
import { GroupHandler } from './group';
import { MonsterMovementtHandler } from './monster-movement/handler';
import { PlayerMovementHandler } from './player/movement';
import { SpellHandler } from './spells';
import { UpdateObjectHandler } from './update-object/handler';

export class ObjectHandler extends EventEmitter {
  private game: GameHandler;
  public updateObjectHandler: UpdateObjectHandler;

  /**
   * Melee combat, the creature query and the selection send. PUBLIC because the world UI bridge and
   * the click-to-target path both drive it -- it owns `CMSG_SET_SELECTION`, which nothing else may
   * send or the client and the server disagree about what is targeted.
   */
  public combatHandler: CombatHandler;

  // PUBLIC so the movement instruments can read their counters. `MonsterMovementtHandler#stats` and
  // `PlayerMovementHandler#sent` are how a probe distinguishes "the world is still" from "the world
  // is moving and we are not drawing it", which was the whole ambiguity before this task.
  public monsterMovementHandler: MonsterMovementtHandler;

  public playerMovementHandler: PlayerMovementHandler;

  /**
   * The spell book, the action bar's 144 slots and `CMSG_CAST_SPELL`. PUBLIC for the same reason
   * `combatHandler` is: the world UI bridge reads it to answer `HasAction`/`GetActionTexture` and drives
   * it to cast, and it owns the only send of `CMSG_CAST_SPELL`.
   */
  public spellHandler: SpellHandler;

  /**
   * THE COMBAT LOG -- spell damage, periodic ticks, heals, energize and the spell-miss list. PUBLIC
   * for `combatHandler`'s reason exactly: both display media subscribe to it directly, `World` for the
   * floating number and `ui/unit-bridge.ts` for `UNIT_COMBAT`.
   *
   * Separate from `combatHandler` because a swing and a spell are separate wire surfaces; see
   * `combat-log.ts`' header.
   */
  public combatLogHandler: CombatLogHandler;

  /**
   * ITEM TEMPLATES AND THE INVENTORY DESCRIPTORS. PUBLIC for the reason the two above are: the world
   * UI bridge reads it to answer `GetContainerItemInfo` and `GetItemInfo`, and it owns the only send
   * of `CMSG_ITEM_QUERY_SINGLE`.
   *
   * It is fed from TWO doors -- the wire, for the query response, and `UpdateObjectHandler`, for every
   * item/container create and value block. That second door reaches it LAZILY, through
   * `game.objectHandler.itemHandler` at packet time rather than through a constructor reference, so
   * the two handlers have no construction-order coupling to get wrong later.
   */
  public itemHandler: ItemHandler;

  /**
   * LOOTING. PUBLIC for the same reason the others are: the world UI bridge reads the open loot to
   * answer `GetLootSlotInfo`, and this handler owns the only sends of `CMSG_LOOT`,
   * `CMSG_AUTOSTORE_LOOT_ITEM`, `CMSG_LOOT_MONEY` and `CMSG_LOOT_RELEASE`.
   */
  public lootHandler: LootHandler;

  /**
   * GROUPS, DUELS, DUNGEON DIFFICULTY AND INSTANCE RESET. PUBLIC for the same reason the others are:
   * `ui/group-bridge.ts` reads the roster to answer `GetNumPartyMembers`/`UnitInParty` and owns the
   * only sends of `CMSG_GROUP_INVITE`, `CMSG_DUEL_ACCEPTED`, `MSG_SET_DUNGEON_DIFFICULTY` and the rest
   * of the unit-popup family.
   */
  public groupHandler: GroupHandler;

  /**
   * TALKING TO AN NPC. PUBLIC for the same reason the others are: `ui/gossip-bridge.ts` reads the menu
   * to answer `GetGossipOptions`, and this handler owns the only sends of `CMSG_GOSSIP_HELLO`,
   * `CMSG_GOSSIP_SELECT_OPTION` and `CMSG_NPC_TEXT_QUERY`.
   *
   * The hello is also the door every OTHER npc service comes through, so the world's right click
   * drives this one and not the merchant handler -- see `object/gossip.ts`' header.
   */
  public gossipHandler: GossipHandler;

  /**
   * BUYING AND SELLING. PUBLIC for the same reason: `ui/merchant-bridge.ts` reads the vendor's stock to
   * answer `GetMerchantItemInfo`, and this handler owns the only sends of `CMSG_LIST_INVENTORY`,
   * `CMSG_BUY_ITEM`, `CMSG_SELL_ITEM`, `CMSG_BUYBACK_ITEM` and `CMSG_REPAIR_ITEM`.
   */
  public merchantHandler: MerchantHandler;

  // Creates a new character handler
  constructor(gameHandler: GameHandler) {
    super();

    // Holds session
    this.game = gameHandler;
    this.updateObjectHandler = new UpdateObjectHandler(this.game);
    this.monsterMovementHandler = new MonsterMovementtHandler(this.game);
    this.playerMovementHandler = new PlayerMovementHandler(this.game);
    this.combatHandler = new CombatHandler(this.game);
    this.spellHandler = new SpellHandler(this.game);
    this.combatLogHandler = new CombatLogHandler(this.game);
    this.itemHandler = new ItemHandler(this.game);
    this.lootHandler = new LootHandler(this.game);
    this.groupHandler = new GroupHandler(this.game);
    this.gossipHandler = new GossipHandler(this.game);
    this.merchantHandler = new MerchantHandler(this.game);

    // The auto-attack BUTTON's checked state follows the SERVER, not what we sent -- see
    // `SpellHandler#autoAttacking`. `combat.ts` already reads both opcodes for the swing animation and
    // the in-combat mark; this is the same two events observed for the button.
    this.combatHandler.on('autoAttack', (on: boolean) => this.spellHandler.setAutoAttack(on));
  }
}
