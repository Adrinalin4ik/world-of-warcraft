import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel } from '../object';
// Side-effect imports: register the method tables. `worldframe` also registers the WORLDFRAME class's
// own table, but the CLASS itself comes from `object.ts`.
import '../methods/frame';
import '../methods/region';
import '../methods/kinds';
import '../methods/worldframe';

/**
 * HOW AN ADDON FINDS A NAMEPLATE: `WorldFrame:GetChildren()`, walked every tick, each anonymous child
 * treated as a plate; then `GetRegions()` on the plate to reach its bar and its name.
 *
 * Neither the `WorldFrame` type nor any of the four tree reads existed before this round -- the type's
 * absence made `CreateFrame` throw and rule 5 drop the whole `WorldFrame.xml` subtree, and `GetChildren`
 * was missing on every class besides. This covers the happy path of both halves at once, including the
 * split that matters: a `<Texture>`/`<FontString>` is a REGION and everything else is a child FRAME.
 */
test('WorldFrame answers GetChildren and GetRegions, split by kind', () => {
  const vm = new LuaVM();
  installObjectModel(vm, new FrameRegistry());

  const error = vm.run(
    `
    world = CreateFrame("WorldFrame", "WorldFrame")
    plate = CreateFrame("Frame", "Plate1", world)
    bar = CreateFrame("StatusBar", "Plate1HealthBar", plate)
    label = plate:CreateFontString("Plate1Name")
    art = plate:CreateTexture("Plate1Border")

    worldChildren = select("#", world:GetChildren())
    firstChild = (select(1, world:GetChildren())):GetName()
    plateChildren = select("#", plate:GetChildren())
    plateRegions = select("#", plate:GetRegions())
    plateNumChildren = plate:GetNumChildren()
    plateNumRegions = plate:GetNumRegions()
    firstRegion = (select(1, plate:GetRegions())):GetName()
    `,
    'tree-walk.test.lua',
  );
  expect(error).toBeNull();

  // `runExpr` answers a `LuaError` OR a `{ value }`, so the narrowing is real and not a cast: an
  // expression that raised must not silently compare equal to `undefined` and pass.
  const read = (name: string): unknown => {
    const answer = vm.runExpr(`return ${name}`, 'read.lua');
    expect(answer !== null && 'value' in answer).toBe(true);
    return (answer as { value: unknown }).value;
  };
  // The plate is the WorldFrame's only child, exactly as an addon's walk would find it.
  expect(read('worldChildren')).toBe(1);
  expect(read('firstChild')).toBe('Plate1');
  // The bar is a child FRAME; the font string and the texture are REGIONS. Three things parented to the
  // plate, split 1/2 by kind and never counted twice.
  expect(read('plateChildren')).toBe(1);
  expect(read('plateRegions')).toBe(2);
  expect(read('plateNumChildren')).toBe(1);
  expect(read('plateNumRegions')).toBe(2);
  expect(read('firstRegion')).toBe('Plate1Name');
});
