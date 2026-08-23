/**
 * WHICH MODEL A GAMEOBJECT WEARS -- `GameObjectDisplayInfo.dbc`, keyed by `GAMEOBJECT_DISPLAYID`.
 *
 * The first step of making the world's objects exist at all. The owner's report is the plainest possible
 * statement of the gap: "у меня квест на сбор предметов. Т.е. предмет не выпадает с моба, а собрается в
 * мире. Вот тут кусты нужно залутать." There were no bushes to click, because this client had never
 * created a single GameObject -- `update-object/handler.ts` dropped every pack that was not a UNIT or a
 * PLAYER, so an object never became an entity, never got a model, and could never be picked.
 *
 * ## MEASURED, not transcribed
 *
 * The served file, read byte-for-byte before anything was built on it: `WDBC`, **3790 records, 19
 * fields, recordSize 76, stringBlock 245947**, and `20 + 3790*76 + 245947 = 534007` -- exactly the
 * bytes served. The residual is zero, so the field list is right rather than plausible. `19 * 4 == 76`
 * confirms every field is a word, which is what makes a single `restructure` entity valid here.
 *
 * The entity itself already existed and was already registered
 * (`wow-data-parser/dbc/entities/game-object-display-info.js`) -- `id`, a `StringRef` `file`, ten sound
 * ids, two bounding-box vectors and an effect package. Nothing had ever read it.
 *
 * ## `.mdx` IS NOT A TYPO, AND IT IS NOT WHAT IS SERVED
 *
 * Row 1 decodes as `World\Generic\ActiveDoodads\Chest02\Chest02.mdx`. **The DBC still names Warcraft
 * III's extension and 3.3.5a ships `.m2`.** That is a real substitution the client makes and not an
 * error in the data: every row in this table ends `.mdx`, while the asset host serves the same stem as
 * `.m2`. Getting this wrong makes every object a 404, and a 404 here returns an HTML page which the M2
 * decoder then fails to parse -- naming the wrong subsystem twice over, exactly as `CLAUDE.md` warns.
 *
 * Lowercased for the same paragraph's other rule: **the asset host is CASE-SENSITIVE**, and these paths
 * are authored in mixed case with backslashes.
 *
 * ## WMO IS A DECLARED GAP
 *
 * Some display rows name a `.wmo` -- a building, not a doodad. Those answer null here rather than being
 * handed to the M2 loader, which would fail to decode them and report it as a broken model. A bush, a
 * chest, a crate and a herb are all M2, so the owner's case is covered; a WMO object simply does not
 * appear, which is a visible absence rather than a wrong render. Named, not hidden.
 *
 * ## THE ARC THIS BEGINS, and what is already standing
 *
 * The owner asked for the whole thing rather than slices, and added two requirements to it while it was
 * being scoped. Written down here because the arc spans several files that do not exist yet, and a
 * requirement remembered in a conversation is a requirement lost.
 *
 *  1. **This table.** Done, and measured.
 *  2. **GameObjects must become entities.** `update-object/handler.ts:251` returns early for any pack
 *     that is not `ObjectType.Unit` or `.Player`, so no object has ever reached the world. The
 *     descriptor half is already built: `enums.ts#GameObjectField` carries 3.3.5a's own block --
 *     `displayid` at `object_end + 0x0002`, `flags`, `dynamic`, `bytes_1` -- and the field-table map
 *     already lists `[ObjectType.GameObject, [ObjectField, GameObjectField]]`. Nothing reads it.
 *  3. **The model in the scene**, off `modelFor` above and the existing M2 pipeline.
 *  4. **The name**, for the tooltip: `CMSG_GAMEOBJECT_QUERY` / `SMSG_GAMEOBJECT_QUERY_RESPONSE`.
 *     Neither is subscribed today.
 *  5. **Pick and cursor.** `world/pick.ts` admits `OBJECT_TYPE_UNIT`/`_PLAYER` only, and
 *     `world/cursor-mode.ts`' header already names the consequence as a declared gap ("there is no
 *     hovered GO to classify"). The reference models the whole GO leg -- `highlightable_flags`,
 *     `go_reaction`, the per-type lock table, `GoLockInputs` -- so this is a port, not a design.
 *  6. **`CMSG_GAMEOBJ_USE`**, and then nothing new: **looting already works.** `object/loot.ts`,
 *     `ui/loot-bridge.ts` and the `CMSG_LOOT` sends are all standing, so a used bush should open the
 *     window this client already draws.
 *  7. **THE SPARKLE.** The owner: "не забудь про анимацию над объектами целями... там партиклы должны
 *     быть." A GameObject that is an active quest objective glows, and the flag driving it is in the
 *     descriptor block above -- `gameobject_dynamic`, which is exactly why step 2 must decode it rather
 *     than only the display id.
 *  8. **THE OPENING CAST.** The owner: "при активации предмета может быть каст открывания. Нужно не
 *     забыть и про кастбар." This one looks free rather than new: `action-bridge.ts:432` already feeds
 *     `SMSG_SPELL_START` into `UNIT_SPELLCAST_START` for the player's own casts, and the Opening spell
 *     is the player's own cast. So it is a CHECK, not a build -- with one specific thing to check,
 *     because `CLAUDE.md` warns this runtime fires no general `OnUpdate` and hand-picks named frames:
 *     `CastingBarFrame` has to be one of them or the bar will appear and never advance.
 */
import DBC from '.';

/** The extension every row carries, and which none of the served files use. See the header. */
const MDX = /\.mdx$/i;

/**
 * A DBC model name -> the path the host actually serves, or **null** when nothing here can serve it.
 *
 * Exported and pure because this one substitution decides whether the whole world draws: get it wrong
 * and every object 404s, and a 404 on this host returns an HTML page that the M2 decoder then fails to
 * parse -- so the error surfaces as a broken model rather than a missing one. See the header.
 */
export function servedPath(file: string): string | null {
  if (!MDX.test(file)) {
    return null;
  }
  return file.replace(MDX, '.m2').toLowerCase();
}

class GameObjectDisplayData {
  private pending: Promise<void> | null = null;

  /** `displayId` -> the served, lowercased `.m2` path. Empty until the DBC lands. */
  private models = new Map<number, string>();

  /**
   * Load the table, once. Idempotent, the same shape as `questXpData.ensureLoaded`.
   *
   * **534 KB**, measured rather than estimated, of which 246 KB is the string block. That is larger
   * than the other tables here and it is still the right call to load it eagerly: it is needed the
   * moment the player is in the world at all -- every crate, chest, door and bush in view keys off it --
   * so deferring it would trade a one-time half-megabyte for a world that starts empty and fills in.
   */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure is retryable rather than poisoning the session. Until it
        // succeeds `modelFor` answers null and no object is drawn -- an empty world, not a wrong one.
        this.pending = null;
        console.warn('gameObjectDisplayData: load failed, no world objects will be drawn', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const table = await DBC.load('GameObjectDisplayInfo');
    const models = new Map<number, string>();
    for (const record of (table as { records?: unknown[] }).records ?? []) {
      const row = record as { id?: number; file?: unknown };
      const file = typeof row?.file === 'string' ? row.file : null;
      if (typeof row?.id !== 'number' || file === null || file === '') {
        continue;
      }
      models.set(row.id, file);
    }
    this.models = models;
  }

  /**
   * The `.m2` path for a display id, or **null** when there is none to draw.
   *
   * Null covers three genuinely different cases and the caller treats them alike, because all three
   * mean "draw nothing": the table has not landed, the id is absent from it, or the row names a `.wmo`
   * this client cannot load. Only the last is a real gap and the header names it.
   */
  modelFor(displayId: number): string | null {
    const file = this.models.get(displayId);
    if (file === undefined) {
      return null;
    }
    return servedPath(file);
  }

  /** Whether the table is loaded, so a caller can tell "not yet" from "no such object". */
  get loaded(): boolean {
    return this.models.size > 0;
  }
}

export const gameObjectDisplayData = new GameObjectDisplayData();

export default gameObjectDisplayData;
