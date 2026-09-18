/**
 * `Languages.dbc` -- the NAME of a chat language, by id.
 *
 * One column pair and nothing else: `{ id, name }` (`wow-data-parser/dbc/entities/languages.js`). The
 * ids are the ones the wire carries in `CMSG_MESSAGECHAT`'s second word and the ones
 * `network/game/object/chat.ts` documents: 0 Universal, 1 Orcish, 7 Common, and the racial tongues
 * between and after them.
 *
 * ## Why this exists at all
 *
 * `GetDefaultLanguage` answered the literal `'Common', 7` for every character, and `chat.ts#send`'s own
 * comment names the consequence: **TrinityCore checks the sender can speak the language before it
 * broadcasts, and a failed check returns without a reply.** So a Horde character's `/say` was refused
 * with total silence -- the same signature the item link spent three rounds on, and a DECLARED limit
 * rather than a surprise, because that comment declared it.
 *
 * The join that closes it is two reads: `ChrRaces.dbc`'s `baseLanguage` for the player's race (see
 * `race-class-data.ts#baseLanguage`) and this file for the name that id carries.
 *
 * ## The name is the LOCALIZED one, which is what the client compares
 *
 * `ChatEdit_UpdateHeader` and `ChatMenu`'s language submenu both put this string on screen, and
 * `chatframe.lua` compares `editBox.language` against `GetDefaultLanguage()`'s FIRST return -- a name,
 * not an id. So answering the id twice would look right in a header and break the comparison, which is
 * the same mistake `race-class-data.ts`' header records for the class token.
 *
 * Loaded lazily and answered null until it lands, which is the contract every other DBC accessor here
 * has: `GetDefaultLanguage` then returns nothing and `chat.ts#send` falls back to its documented
 * default, so a message typed in the first second behaves as it did before this file existed.
 */
import DBC from '.';

class LanguageData {
  private names: Map<number, string> | null = null;

  private pending: Promise<void> | null = null;

  get ready(): boolean {
    return this.names !== null;
  }

  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Retryable rather than poisoned, exactly as `raceClassData` does it.
        this.pending = null;
        console.warn('languageData: load failed, GetDefaultLanguage stays nil', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const table = await DBC.load('Languages');
    const map = new Map<number, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const record of (table as any).records ?? []) {
      if (record && typeof record.id === 'number') {
        const name = String(record.name ?? '');
        if (name !== '') {
          map.set(record.id, name);
        }
      }
    }
    this.names = map;
  }

  /** The localized name for a language id, or null before the fetch lands or for an unknown id. */
  name(id: number): string | null {
    return this.names?.get(id) ?? null;
  }
}

export const languageData = new LanguageData();

export default languageData;
