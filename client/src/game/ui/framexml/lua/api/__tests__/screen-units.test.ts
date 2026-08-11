/**
 * `GetScreenWidth`/`GetScreenHeight` are in LOGICAL (authored) units, not device pixels.
 *
 * The one guard on a fix that is invisible until a window happens to be wider than 16:9. These
 * returned device pixels, and `GlueParent_OnLoad` (interface/gluexml/glueparent.lua:174-184) feeds the
 * difference into `SetPoint`, whose units are authored -- so the glue screen's letterbox bars came out
 * `screenScale` too wide (measured 187.5 device px per side at 1920x900 where 160 is right).
 *
 * The height assertion is the sharp one: 768 is `AUTHORED_HEIGHT`, and it is what the client's own
 * `GetScreenHeightScale()` divides by as a LITERAL (uiparent.lua:2907-2909). A device-pixel answer
 * makes that ratio meaningless.
 */
import { LuaVM } from '../../vm';
import { installScreenApi } from '../screen';

describe('GetScreenWidth/GetScreenHeight units', () => {
  it('report authored units, so the 16:9 letterbox bar comes out the right width', () => {
    const vm = new LuaVM();
    // 1920x900 -- wider than 16:9, which is the only aspect where the letterbox fires at all.
    installScreenApi(vm, { viewport: () => ({ width: 1920, height: 900 }) });

    const read = (expression: string): number => {
      const result = vm.runExpr(`return ${expression}`, 'test');
      if (!('value' in result)) {
        throw new Error(`lua failed: ${result.message}`);
      }
      return Number(result.value);
    };

    // Height is the authored virtual screen exactly; width grows with the aspect.
    expect(read('GetScreenHeight()')).toBeCloseTo(768, 6);
    expect(read('GetScreenWidth()')).toBeCloseTo((1920 * 768) / 900, 6);

    // GlueParent_OnLoad's own arithmetic, in authored units, and what it means back in device pixels.
    const barWidth = read('(GetScreenWidth() - GetScreenHeight() * 16 / 9) / 2');
    expect(barWidth).toBeCloseTo(136.5333, 3);
    expect(barWidth * (900 / 768)).toBeCloseTo(160, 3);
  });
});
