/**
 * @jest-environment node
 *
 * ATTACHMENT-ID PROBE for the spell visual kit's emitter slots -- the client's own decoders over real
 * served bytes, no browser. Copied in shape from `build.js` (same `require('../src/...').default` +
 * `DecodeStream` route), for the harness's own stated reason: a question about a number in a game file
 * is answered by the code the browser runs.
 *
 * THE QUESTION. A kit slot's attachment tag is a compile-time immediate in the real client's slot
 * loop, not a DBC column, so the only source for it is the reference -- which is 1.12. This probe is
 * what turns "the reference says 0x13" into "0x13 is the model origin on all 23 of these 3.3.5a rigs".
 * `src/game/classes/spell-kit-fx.ts` records the results; this is the instrument that produced them.
 *
 * Two independent checks:
 *   1. the tags against real M2 attachment tables (`M2_DIR`);
 *   2. the tags against `SpellVisualKitModelAttach.dbc`, a table that does not exist in 1.12 and is
 *      therefore independent of the reference (`DBC_DIR`).
 *
 * Run (fetch the files first; the asset host is case-sensitive and wants all-lowercase paths):
 *
 *   M2_DIR=<dir of .m2>  DBC_DIR=<dir of .dbc>  CI=true node scripts/test.js --watchAll=false \
 *     --roots harness --testMatch "**\/attach-probe.test.js"
 *
 * Either directory may be absent: the arm that needs it reports SKIPPED rather than failing, so an
 * offline checkout does not turn a missing fixture into a red suite.
 */
const fs = require('fs');
const path = require('path');
const { DecodeStream } = require('restructure');
const M2Parser = require('../src/wow-data-parser/m2').default;
const SpellVisualKitModelAttach = require('../src/wow-data-parser/dbc/entities/spell-visual-kit-model-attach').default;

const M2_DIR = process.env.M2_DIR;
const DBC_DIR = process.env.DBC_DIR;

/**
 * The reference's nine kit emitter tags, in ITS field order
 * (`benilla-formats/src/spell_visual/mod.rs:104-108`). 3.3.5a has eleven slots; the two it adds are
 * not here because no tag is known for them -- see `spell-kit-fx.ts#UNTAGGED_SLOTS`.
 */
const REFERENCE_TAGS = [
  { tag: 0x14, name: 'Head' },
  { tag: 0x22, name: 'Chest' },
  { tag: 0x13, name: 'Base' },
  { tag: 0x15, name: 'LeftHand' },
  { tag: 0x16, name: 'RightHand' },
  { tag: 0x11, name: 'Breath' },
  { tag: 0x17, name: 'Special1' },
  { tag: 0x18, name: 'Special2' },
  { tag: 0x19, name: 'Special3' },
];

/** The six the file header claims are unanimous. Asserted below, so a new rig that breaks one fails here. */
const UNANIMOUS = [0x14, 0x22, 0x13, 0x15, 0x16, 0x11];

const NL = String.fromCharCode(10);

function decodeFile(dir, file, parser) {
  return parser.decode(new DecodeStream(fs.readFileSync(path.join(dir, file))));
}

/**
 * Whether a file is really an M2, by its own magic.
 *
 * NOT paranoia -- this cost a probe run. The asset host answers a missing path with an HTML error page
 * and a 200-shaped body, and `curl -o` writes it out under the `.m2` name you asked for. Decoding that
 * as an M2 reads the `<!do` of `<!doctype` as counts and offsets, and node dies with
 * `Fatal JavaScript invalid size error` inside V8 rather than raising anything catchable -- so the
 * failure names the M2 parser for what is really a 404. `CLAUDE.md` records this trap in general terms;
 * this is the arm that got bitten by it.
 *
 * `MD20` = 0x4d 0x44 0x32 0x30. Anything else is announced and skipped.
 */
function isM2(dir, file) {
  const fd = fs.openSync(path.join(dir, file), 'r');
  const head = Buffer.alloc(4);
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head.toString('latin1') === 'MD20';
}

it('the reference tags against real M2 attachment tables', () => {
  if (!M2_DIR || !fs.existsSync(M2_DIR)) {
    console.log('SKIPPED: set M2_DIR to a directory of served .m2 files');
    return;
  }
  const all = fs.readdirSync(M2_DIR).filter((f) => f.endsWith('.m2'));
  const files = all.filter((f) => isM2(M2_DIR, f));
  for (const f of all.filter((f) => !files.includes(f))) {
    console.log(`SKIPPED ${f}: not an M2 (no MD20 magic) -- almost certainly a saved 404 page`);
  }
  const lines = [];
  const presence = new Map(REFERENCE_TAGS.map((t) => [t.tag, []]));

  for (const file of files) {
    const m2 = decodeFile(M2_DIR, file, M2Parser);
    const byId = new Map(m2.attachments.map((a) => [a.id, a]));
    const lookups = m2.attachmentLookups;
    lines.push(`${file}  v${m2.version}  bones=${m2.bones.length}  attachments=${m2.attachments.length}`);
    for (const { tag, name } of REFERENCE_TAGS) {
      const rec = byId.get(tag);
      // `attachmentLookups` is the engine's own id -> index map; -1 there means the rig has no such
      // point. It must agree with the record scan, and a disagreement would mean our decode is wrong.
      const lookup = tag < lookups.length ? lookups[tag] : -1;
      expect(rec !== undefined).toBe(lookup !== -1);
      if (rec) {
        presence.get(tag).push({ file, pos: rec.position.map((v) => Math.round(v * 1e4) / 1e4) });
      }
      const pos = rec ? JSON.stringify(rec.position.map((v) => Math.round(v * 1e4) / 1e4)) : '-';
      lines.push(`   ${name.padEnd(10)} 0x${tag.toString(16)} ${String(tag).padStart(3)}  ${rec ? 'PRESENT' : 'ABSENT '}  lookup=${String(lookup).padStart(3)}  pos=${pos}`);
    }
  }

  lines.push('');
  for (const { tag, name } of REFERENCE_TAGS) {
    lines.push(`${name.padEnd(10)} 0x${tag.toString(16)}: present on ${presence.get(tag).length} / ${files.length} models`);
  }
  console.log(lines.join(NL));

  expect(files.length).toBeGreaterThan(0);

  // THE UNANIMOUS SIX. `spell-kit-fx.ts` states these as present on every rig probed, so this is what
  // keeps that claim honest as models are added to the fixture directory.
  for (const tag of UNANIMOUS) {
    expect(presence.get(tag)).toHaveLength(files.length);
  }

  // BASE IS THE MODEL ORIGIN. The strongest single agreement with the reference and the one most worth
  // an assertion -- no other attachment id in these files sits at the origin.
  //
  // A TOLERANCE, not equality, and the tolerance is what the data forced: 22 of the 23 rigs carry
  // exact zeros (several as NEGATIVE zero, which is why `toEqual([0,0,0])` fails on them even though
  // the number is 0), but `draeneimale.m2` carries z = 1.3209e-4. So "exactly the origin" is false for
  // one file and "the origin to within a tenth of a millimetre on a 2.2-yard body" is true for all.
  // 1e-3 yards is under a millimetre and still four orders below the nearest real attachment offset.
  for (const { file, pos } of presence.get(0x13)) {
    for (const axis of pos) {
      expect(Math.abs(axis)).toBeLessThan(1e-3);
    }
    expect(typeof file).toBe('string');
  }

  // THE HAND PAIR'S SIGN CONVENTION, which is what confirms the reference's left/right naming against
  // the convention `ui/scene/character-attachments.ts` had already measured on this build: negative Y
  // is the character's RIGHT. A swap would mirror every hand effect.
  for (const { pos } of presence.get(0x15)) {
    expect(pos[1]).toBeGreaterThan(0);
  }
  for (const { pos } of presence.get(0x16)) {
    expect(pos[1]).toBeLessThan(0);
  }
});

it('the reference tags against SpellVisualKitModelAttach, a table 1.12 does not have', () => {
  if (!DBC_DIR || !fs.existsSync(path.join(DBC_DIR, 'spellvisualkitmodelattach.dbc'))) {
    console.log('SKIPPED: set DBC_DIR to a directory holding spellvisualkitmodelattach.dbc');
    return;
  }
  const set = decodeFile(DBC_DIR, 'spellvisualkitmodelattach.dbc', SpellVisualKitModelAttach.dbc);
  const rows = set.records;
  const tags = new Set(REFERENCE_TAGS.map((t) => t.tag));

  const counts = new Map();
  for (const row of rows) {
    // Signed: -1 is the world-plant sentinel, the same convention the reference records for the kit's
    // own twelfth slot.
    const id = row.attachmentID > 0x7fffffff ? row.attachmentID - 0x100000000 : row.attachmentID;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const named = new Map(REFERENCE_TAGS.map((t) => [t.tag, t.name]));
  console.log([
    `SpellVisualKitModelAttach: ${rows.length} rows`,
    ...sorted.map(([id, n]) => `   ${String(id).padStart(4)} x${String(n).padEnd(4)} ${named.get(id) ?? (id === -1 ? 'world plant (-1)' : 'not one of the reference nine')}`),
  ].join(NL));

  const inReference = sorted.filter(([id]) => tags.has(id)).reduce((a, [, n]) => a + n, 0);
  const worldPlant = counts.get(-1) ?? 0;
  console.log(`rows naming one of the reference nine: ${inReference} / ${rows.length}`);
  console.log(`rows at the -1 world-plant sentinel:   ${worldPlant} / ${rows.length}`);

  // The corroboration `spell-kit-fx.ts` records: a table the reference never saw concentrates on the
  // ids the 1.12 client hardcodes. Asserted as a majority rather than an exact count, so a re-extract
  // of the data does not fail the suite over a row or two.
  expect(inReference / rows.length).toBeGreaterThan(0.5);
  expect(worldPlant).toBeGreaterThan(0);
});
