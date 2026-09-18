/**
 * `ChatChannels.dbc` -- the built-in chat channels, and the two facts an auto-join needs.
 *
 * SIX ROWS on the served file, and both questions I was about to guess at are stated by the data.
 * Dumped before any of this was written (`WDBC`, 6 records, 37 fields, recordSize 148):
 *
 *     id   flags      name
 *     1    0x80003    General - %s
 *     2    0x0003B    Trade - %s
 *     22   0x10003    LocalDefense - %s
 *     23   0x10004    WorldDefense
 *     25   0x20032    GuildRecruitment - %s
 *     26   0x40039    LookingForGroup
 *
 * ## Zone-dependence is in the NAME, not in a flag
 *
 * `General - %s` carries the substitution itself; `WorldDefense` and `LookingForGroup` do not. So there
 * is no flag bit to identify and no guess to make: a name containing `%s` is a zone channel, and the
 * `%s` is where the zone goes. That is why `nameFor` takes the zone as an argument rather than a
 * "isZoneChannel" boolean.
 *
 * ## The auto-join set is flag bit 0x1
 *
 * Set on General, Trade, LocalDefense and LookingForGroup; clear on WorldDefense and GuildRecruitment.
 * That is exactly the set a fresh character finds itself in -- and it is a READ rather than the
 * transcription this file would otherwise have carried. The bit's NAME is not stated anywhere served, so
 * it is called `AUTO_JOIN` here after what it selects, and the six-row table above is the whole of the
 * evidence: two rows lack it and those two are the two nobody is auto-joined to.
 *
 * The `factionGroup` column is 0 on every row, so nothing here filters by faction. If a build appears
 * where it is not, that is the place to look.
 */
import DBC from '.';

/** One built-in channel: its DBC id and the name template, `%s` and all. */
export interface ChannelRow {
  id: number;
  /** `General - %s`, or a bare name for a channel that is not zone-dependent. */
  template: string;
}

/**
 * `flags & 0x1` -- the channels a character is joined to without asking. See the header.
 *
 * Named after what it selects, because no served file names the bit.
 */
const AUTO_JOIN = 0x1;

class ChatChannelData {
  private rows: ChannelRow[] | null = null;

  private pending: Promise<void> | null = null;

  get ready(): boolean {
    return this.rows !== null;
  }

  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Retryable rather than poisoned, exactly as `raceClassData` does it.
        this.pending = null;
        console.warn('chatChannelData: load failed, no channel is auto-joined', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const table = await DBC.load('ChatChannels');
    const out: ChannelRow[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const record of (table as any).records ?? []) {
      if (record && typeof record.id === 'number' && typeof record.flags === 'number') {
        const template = String(record.name ?? '');
        if (template !== '' && (record.flags & AUTO_JOIN) !== 0) {
          out.push({ id: record.id, template });
        }
      }
    }
    this.rows = out;
  }

  /** The channels flagged for auto-join, or an empty list before the fetch lands. */
  get autoJoin(): ChannelRow[] {
    return this.rows === null ? [] : this.rows.map((row) => ({ ...row }));
  }
}

/**
 * A row's name for a zone, or null when it cannot be built yet.
 *
 * NULL RATHER THAN A NAME WITH A HOLE IN IT: `General - ` would be a channel nobody is in, and joining
 * it would put a phantom row in the list and a phantom tab in the UI. A template with no `%s` needs no
 * zone and always answers.
 */
export function nameFor(row: ChannelRow, zone: string): string | null {
  if (!row.template.includes('%s')) {
    return row.template;
  }
  if (zone === '') {
    return null;
  }
  return row.template.replace('%s', zone);
}

export const chatChannelData = new ChatChannelData();

export default chatChannelData;
