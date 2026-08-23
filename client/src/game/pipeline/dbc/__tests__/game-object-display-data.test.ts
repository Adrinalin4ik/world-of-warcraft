import { servedPath } from '../game-object-display-data';

/**
 * THE ONE SUBSTITUTION THAT DECIDES WHETHER THE WORLD'S OBJECTS DRAW AT ALL.
 *
 * `GameObjectDisplayInfo.dbc` names every model with Warcraft III's `.mdx` and 3.3.5a ships `.m2`, on a
 * host that is case-sensitive. Both halves are load-bearing and both fail the same misleading way: a
 * 404 here returns an HTML page, which the M2 decoder then fails to parse -- so the console blames the
 * model pipeline for what is actually a wrong path.
 *
 * The inputs are real rows read off the served file, not invented ones: row 1 and row 3 verbatim.
 */
test('a DBC model name becomes the served path, and a WMO row is refused', () => {
  expect(servedPath('World\\Generic\\ActiveDoodads\\Chest02\\Chest02.mdx'))
    .toBe('world\\generic\\activedoodads\\chest02\\chest02.m2');
  expect(servedPath('World\\Azeroth\\Stranglethorn\\Buildings\\TrollWatchTower\\TrollWatchTower.mdx'))
    .toBe('world\\azeroth\\stranglethorn\\buildings\\trollwatchtower\\trollwatchtower.m2');

  // A building, which this client cannot load -- null draws nothing rather than handing a WMO to the M2
  // decoder and reporting the failure as a broken model. The declared gap, asserted so it stays declared.
  expect(servedPath('World\\wmo\\Azeroth\\Buildings\\Something.wmo')).toBeNull();
});
