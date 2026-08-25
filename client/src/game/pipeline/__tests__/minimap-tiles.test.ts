import { parseTranslate } from '../minimap-tiles';

/**
 * THE SHAPE TEST, and it exists because the wrong answer here is SILENT.
 *
 * `md5translate.trs` indexes many things and only a minority of its lines are minimap tiles -- measured
 * on the served file, 7,534 of 18,644 tab-separated pairs. A parse that accepted every pair would fill
 * the table with doodad textures keyed by whatever digits were in their names, and every lookup would
 * then answer confidently and wrongly.
 *
 * Every line below is a REAL line from the served file, not a constructed one: the `dir:` header, a
 * genuine Azeroth tile with the hash the host actually serves, and the Tanaris doodad whose name ends in
 * two underscore-separated numbers -- which is precisely the shape that a loose pattern would swallow.
 */
const REAL_LINES = [
  'dir: Azeroth',
  'Azeroth\\map32_48.blp\tb53fb722839e0c7a81bae678ea694f5c.blp',
  'Azeroth\\map24_53.blp\t67ba43d493e62a8fad5de319e6d4cb05.blp',
  'Kalimdor\\Tanaris\\PassiveDoodads\\Ruins\\TanarisRuins03_000_00_00.blp'
    + '\t411a2e26ee04ad42a35dc2ad60440370.blp',
].join('\n');

test('only map<Y>_<X> lines become tiles, and a doodad ending in numbers does not', () => {
  const parsed = parseTranslate(REAL_LINES);

  // Three pairs read, two of them tiles. The doodad is the one that must be refused.
  expect(parsed.pairs).toBe(3);
  expect(parsed.tiles.size).toBe(2);

  // The chain this whole file rests on: Northshire is ADT tile (Y 32, X 48) by our own naming
  // (`pipeline/adt/index.js:41`), and this is the hash the host answers 200 for.
  expect(parsed.tiles.get('azeroth/32_48')).toBe('b53fb722839e0c7a81bae678ea694f5c.blp');
});
