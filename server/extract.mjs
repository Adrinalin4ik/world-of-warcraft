#!/usr/bin/env node --experimental-modules --no-warnings

/**
 * usage notes:
 * 1) place this script in blizzardry folder
 * 2) `npm install globby`
 * 3) update `dataDir` to point to your World of Warcraft installation
 * 4) update `outDir` to where you want the files to end up
 * 5) run `node --experimental-modules <this-script>.mjs *.blp`
 * 6) rinse repeat with pattern for any other files you want to extract (for example `Interface*`)
 *
 * Note: this script has only been tested on macOS, use at your own risk
 */

import fs from 'fs';
import path from 'path';

import glob from 'globby';

import MPQ from '../blizzardry/lib/mpq/index.js';

const dataDir = '/home/alexey/Desktop/World_of_Warcraft/Data/';
const outDir = '/media/alexey/Seagate Backup Plus Drive/ExtractedData';

const mpqs = [
  'common.MPQ',
  'common-2.MPQ',
  'expansion.MPQ',
  'lichking.MPQ',
  '*/locale-*.MPQ',
  '*/speech-*.MPQ',
  '*/expansion-locale-*.MPQ',
  '*/lichking-locale-*.MPQ',
  '*/expansion-speech-*.MPQ',
  '*/lichking-speech-*.MPQ',
  '*/patch-????.MPQ',
  '*/patch-*.MPQ',
  'patch.MPQ',
  'patch-*.MPQ',
];

const patterns = mpqs.map(mpq => (
  path.join(dataDir, mpq)
));

const archives = glob.sync(patterns);

const mpq = MPQ.open(archives.shift(), MPQ.OPEN.READ_ONLY);
archives.forEach((archive) => {
  mpq.patch(archive, '');
});

const [,, pattern] = process.argv;
if (!pattern) {
  throw new Error('No pattern given');
}

let count = 0;
mpq.files.find(pattern).forEach(file => {
  const normalized = file.filename.replace(/\\/g, '/');
  const outPath = path.join(outDir, normalized);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  mpq.files.extract(file.filename, outPath);
  console.log(`Extracted ${file.filename}`);
  ++count;
});
console.log(`Extracted ${count} files`);