import { PerfHud, PerfPayload } from '../../game/perf/hud';
import { wantsDebugPanels } from '../debug-flags';

describe('?debug=true', () => {
  it('is off by default and on only for the literal flag', () => {
    expect(wantsDebugPanels('')).toBe(false);
    expect(wantsDebugPanels('?offline=1&ui=lua')).toBe(false);
    expect(wantsDebugPanels('?offline=1&ui=lua&debug=true')).toBe(true);
  });

  /**
   * The gate that matters: hiding the HUD must not remove the DOM node's CONTENTS from some other
   * path -- it must remove the node. A hidden HUD that still built and wrote to an element would
   * keep every cost the visible one has and only stop being seen.
   */
  it('builds no perf-hud element when the HUD is hidden', () => {
    const payload: PerfPayload = {
      frame: { last: 12, p50: 11, p99: 20, worst: 33, overBudget: 4, sampleCount: 300 },
      gpuMs: null,
      sections: new Map([['render', 3.5]]),
      calls: 1, triangles: 1, programs: 1, geometries: 1, textures: 1,
      visibleChunks: 1, visibleGroups: 1, visibleMapDoodads: 1, loadedMapDoodads: 1, visibleDoodads: 1,
    };
    const hidden = new PerfHud(document, false);
    hidden.update(0, payload);
    expect(document.querySelectorAll('[data-perf-hud]')).toHaveLength(0);
    hidden.dispose();
  });
});
