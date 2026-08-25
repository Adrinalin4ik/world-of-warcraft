/**
 * MINIMAP TRACKING -- the "Выбор объекта слежения" menu and the blips it turns on.
 *
 * The owner: "Миникарта имеет конфигурацию объектов слежения, это тоже должно работать."
 *
 * ## What the client asks for, and what it does with it
 *
 * `MiniMapTrackingDropDown_Initialize` walks `1..GetNumTrackingTypes()` and reads
 * `name, texture, active, category = GetTrackingInfo(id)` for each, then adds a final "None" row whose
 * `checked` is set only when nothing is active (`minimap.lua:424-467`). `MiniMapTracking_SetTracking`
 * passes the id straight to `SetTracking(id)`, with **nil for the None row**. And
 * `MiniMapTracking_Update` reads `GetTrackingTexture()` for the button's own icon (`:408-414`).
 *
 * So four globals, and the menu is entirely derived from them -- there is no list in Lua to match.
 *
 * ## The LIST is the engine's, and the owner's screenshot is the check on it
 *
 * Every label is a `GlobalStrings.lua` entry, so a Russian client localises itself and nothing here is
 * an English literal. His screenshot showed twelve rows plus "Нет", in this order: Ремонт, Еда и
 * напитки, Реагенты, Хозяин таверны, Распорядитель полетов, Военачальник, Учитель классовых навыков,
 * Учителя профессий, Аукционер, Банкир, Почтовый ящик, Задания низкого уровня. That is exactly
 * `MINIMAP_TRACKING_REPAIR`, `_VENDOR_FOOD`, `_VENDOR_REAGENT`, `_INNKEEPER`, `_FLIGHTMASTER`,
 * `_BATTLEMASTER`, `_TRAINER_CLASS`, `_TRAINER_PROFESSION`, `_AUCTIONEER`, `_BANKER`, `_MAILBOX`,
 * `_TRIVIAL_QUESTS` (`globalstrings.lua:4932-4946`), in that order.
 *
 * **Three more strings exist and his list does not show them**, which is the evidence for the class
 * filter: `_VENDOR_AMMO`, `_VENDOR_POISON` and `_STABLEMASTER`. Ammunition and the stable are a
 * hunter's, poisons a rogue's. So the engine filters the list by class, and the absence of exactly
 * those three from a non-hunter non-rogue is what says so.
 *
 * ## Tracking townsfolk is CLIENT-side
 *
 * Nothing is sent. A tracking SPELL (Find Herbs) writes `PLAYER_TRACK_CREATURES` server-side, but the
 * townsfolk categories are a display filter over what the client can already see -- and it can:
 * `UNIT_NPC_FLAGS` is decoded onto every unit (`update-object/unit-fields.ts:65`) and
 * `world/cursor-mode.ts:111-133` already names every bit. So a category is an npcFlags MASK, and
 * turning one on means drawing a blip for each entity that carries it.
 *
 * `MAILBOX` is the one with no unit flag: a mailbox is a GameObject, not a creature, so it has no
 * `UNIT_NPC_FLAGS` at all. Its row is offered because the client's list has it and its label exists,
 * and it selects nothing -- named here rather than quietly dropped from the menu, because a menu that
 * disagrees with the real client's is a worse lie than a row that finds nothing.
 *
 * `TRIVIAL_QUESTS` is the other: it is not a category of NPC but a filter on the quest blips, and it is
 * honoured where those are built rather than here.
 */
import { NPC_FLAG } from '../world/cursor-mode';

/** One row of the tracking menu. `flag` 0 means the row selects nothing -- see the header on MAILBOX. */
export interface TrackingType {
  /** The `GlobalStrings.lua` key. Resolved through the VM so a localised build localises itself. */
  stringKey: string;
  /** `Interface\Minimap\Tracking\<file>` -- the engine's own icon folder. */
  texture: string;
  /** The `UNIT_NPC_FLAGS` bits an entity must carry to be blipped, or 0. */
  flag: number;
  /**
   * The class this row belongs to, or null for everyone.
   *
   * `classId` from `ChrClasses`: 3 Hunter, 4 Rogue. See the header for why the filter exists at all --
   * the owner's own screenshot is the evidence.
   */
  onlyClass: number | null;
}

/**
 * The list, in the client's own order.
 *
 * The ORDER is the owner's screenshot read top to bottom, which is the only statement of it available:
 * no file in the manifest carries this list, because the engine supplies it.
 */
export const TRACKING_TYPES: readonly TrackingType[] = [
  { stringKey: 'MINIMAP_TRACKING_REPAIR', texture: 'Repair', flag: NPC_FLAG.REPAIR, onlyClass: null },
  {
    stringKey: 'MINIMAP_TRACKING_VENDOR_FOOD',
    texture: 'Food',
    flag: NPC_FLAG.VENDOR_FOOD,
    onlyClass: null,
  },
  {
    stringKey: 'MINIMAP_TRACKING_VENDOR_REAGENT',
    texture: 'Reagents',
    flag: NPC_FLAG.VENDOR_REAGENT,
    onlyClass: null,
  },
  {
    stringKey: 'MINIMAP_TRACKING_INNKEEPER',
    texture: 'Innkeeper',
    flag: NPC_FLAG.INNKEEPER,
    onlyClass: null,
  },
  {
    stringKey: 'MINIMAP_TRACKING_FLIGHTMASTER',
    texture: 'FlightMaster',
    flag: NPC_FLAG.FLIGHTMASTER,
    onlyClass: null,
  },
  {
    stringKey: 'MINIMAP_TRACKING_BATTLEMASTER',
    texture: 'BattleMaster',
    flag: NPC_FLAG.BATTLEMASTER,
    onlyClass: null,
  },
  {
    stringKey: 'MINIMAP_TRACKING_TRAINER_CLASS',
    texture: 'Class',
    flag: NPC_FLAG.TRAINER_CLASS,
    onlyClass: null,
  },
  {
    stringKey: 'MINIMAP_TRACKING_TRAINER_PROFESSION',
    texture: 'Profession',
    flag: NPC_FLAG.TRAINER_PROFESSION,
    onlyClass: null,
  },
  {
    stringKey: 'MINIMAP_TRACKING_AUCTIONEER',
    texture: 'Auctioneer',
    flag: NPC_FLAG.AUCTIONEER,
    onlyClass: null,
  },
  { stringKey: 'MINIMAP_TRACKING_BANKER', texture: 'Banker', flag: NPC_FLAG.BANKER, onlyClass: null },
  // No unit flag: a mailbox is a GameObject. See the header.
  { stringKey: 'MINIMAP_TRACKING_MAILBOX', texture: 'Mailbox', flag: 0, onlyClass: null },
  // Hunter only, per the owner's screenshot omitting both from a non-hunter.
  {
    stringKey: 'MINIMAP_TRACKING_VENDOR_AMMO',
    texture: 'Ammunition',
    flag: NPC_FLAG.VENDOR_AMMO,
    onlyClass: 3,
  },
  {
    stringKey: 'MINIMAP_TRACKING_STABLEMASTER',
    texture: 'StableMaster',
    flag: NPC_FLAG.STABLEMASTER,
    onlyClass: 3,
  },
  // Rogue only, same evidence.
  {
    stringKey: 'MINIMAP_TRACKING_VENDOR_POISON',
    texture: 'Poisons',
    flag: NPC_FLAG.VENDOR_POISON,
    onlyClass: 4,
  },
  // Not a kind of NPC -- a filter on the quest blips, honoured where those are built.
  {
    stringKey: 'MINIMAP_TRACKING_TRIVIAL_QUESTS',
    texture: 'None',
    flag: 0,
    onlyClass: null,
  },
];

/**
 * WHERE THE CHOICE SURVIVES A RELOAD -- the owner: "он должен сохраняться как и масштаб между
 * перезапусками."
 *
 * The same store and the same reasoning as the minimap zoom
 * (`framexml/lua/methods/minimap.ts#ZOOM_STORAGE_KEY`): the real client keeps it in saved variables,
 * this project has none, and the value is ENGINE state -- the client never asks for a tracking CVar,
 * it reads the choice back through `GetTrackingInfo`'s `active`.
 *
 * The `stringKey` is stored, not the index. An index would silently point at a different category if
 * this list ever gains a row, and the list is transcribed from a screenshot rather than read from a
 * file -- so it is exactly the kind of thing that will gain a row.
 */
const TRACKING_STORAGE_KEY = 'wow.minimap.tracking';

/** The active row's index into `TRACKING_TYPES`, or null for "None". */
let active: number | null = null;

/** Whether storage has been consulted. See `readStored`. */
let restored = false;

function readStored(): void {
  if (restored) {
    return;
  }
  restored = true;
  try {
    const key = window.localStorage.getItem(TRACKING_STORAGE_KEY);
    if (key !== null) {
      const at = TRACKING_TYPES.findIndex((type) => type.stringKey === key);
      active = at < 0 ? null : at;
    }
  } catch {
    // A private window, or site data blocked. Tracking simply starts at None.
  }
}

function writeStored(): void {
  try {
    const row = active === null ? null : TRACKING_TYPES[active] ?? null;
    if (row === null) {
      window.localStorage.removeItem(TRACKING_STORAGE_KEY);
    } else {
      window.localStorage.setItem(TRACKING_STORAGE_KEY, row.stringKey);
    }
  } catch {
    // Nothing to do and nothing to report: the choice still holds for this session.
  }
}

/** Which rows this class sees, in order. `GetTrackingInfo(id)` is `visible()[id - 1]`. */
export function visibleTracking(classId: number): TrackingType[] {
  return TRACKING_TYPES.filter((type) => type.onlyClass === null || type.onlyClass === classId);
}

export function activeTracking(): TrackingType | null {
  readStored();
  return active === null ? null : TRACKING_TYPES[active] ?? null;
}

/**
 * `SetTracking(id)` -- the id is 1-based into the CLASS-FILTERED list, and nil means None.
 *
 * Stored against the unfiltered list so the choice survives a class filter that cannot change anyway;
 * translating on the way in rather than out keeps every reader from having to know about the filter.
 */
export function setTracking(classId: number, id: number | null): void {
  if (id === null) {
    active = null;
    restored = true;
    writeStored();
    return;
  }
  const chosen = visibleTracking(classId)[id - 1];
  active = chosen === undefined ? null : TRACKING_TYPES.indexOf(chosen);
  // Consulted BEFORE writing, so a first-ever `SetTracking` cannot be overwritten by a later read.
  restored = true;
  writeStored();
}

/**
 * A row's icon as the CLIENT wants it: a texture name with **no extension**.
 *
 * This is what `GetTrackingTexture` and `GetTrackingInfo` answer, and the client hands it straight
 * to `SetTexture` -- where the widget layer resolves the file. Every texture path in FrameXML is
 * written this way, so returning one with `.blp` on it would be the odd one out.
 */
export function trackingTexturePath(type: TrackingType): string {
  return `Interface\\Minimap\\Tracking\\${type.texture}`;
}

/**
 * The same icon as the BLP DECODER wants it: the file, with its extension.
 *
 * **Two functions because the two consumers are not the same, and one path served both.** The
 * owner caught it as a 404 on `interface/minimap/tracking/repair` -- no extension, because the
 * blip layer was handed the string meant for `SetTexture` and passed it to `WorkerPool` as a
 * filename. A texture NAME and a FILE differ by exactly this, and the quest glyphs never showed it
 * because their paths are literals in `ui/minimap-blips.ts` and were written with `.blp` already.
 */
export function trackingTextureFile(type: TrackingType): string {
  return `${trackingTexturePath(type)}.blp`;
}
