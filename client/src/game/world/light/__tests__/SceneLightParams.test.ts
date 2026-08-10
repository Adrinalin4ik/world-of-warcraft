import SceneLightParams from '../SceneLightParams';
import { DEFAULT_FOG_BAND, unpackFogParams } from '../fog';

// Regression test for a default `fogParams` built by hand instead of via `packFogParams`: the `x`
// component came out POSITIVE, which pins the shader's fog factor to 0 at every distance -- i.e. no
// fog at all -- for any material rendered before it ever receives a real light. A wrong-signed
// packed pair is exactly the class of bug a one-line test catches forever.
describe('SceneLightParams default fogParams', () => {
  it('unpacks to the band it was built from', () => {
    const params = new SceneLightParams();
    const { x, y } = params.fogParams;
    const { start, end } = unpackFogParams(x, y);

    expect(start).toBeCloseTo(DEFAULT_FOG_BAND.start, 4);
    expect(end).toBeCloseTo(DEFAULT_FOG_BAND.end, 4);
  });

  it('has a negative x -- a positive x pins the fog factor to 0 at every distance', () => {
    const params = new SceneLightParams();
    expect(params.fogParams.x).toBeLessThan(0);
  });

  it('packs the same default band for the WMO interior fog', () => {
    const params = new SceneLightParams();
    const { x, y } = params.wmoFogParams;
    const { start, end } = unpackFogParams(x, y);

    expect(start).toBeCloseTo(DEFAULT_FOG_BAND.start, 4);
    expect(end).toBeCloseTo(DEFAULT_FOG_BAND.end, 4);
  });
});
