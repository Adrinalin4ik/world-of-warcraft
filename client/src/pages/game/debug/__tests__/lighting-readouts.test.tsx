import { render, screen } from '@testing-library/react';
import React from 'react';
import LightingReadouts, { LightingReadoutsTarget } from '../lighting-readouts';

const target = (overrides: Partial<LightingReadoutsTarget> = {}): LightingReadoutsTarget => ({
  mapId: 0,
  sampledPosition: { x: 1.25, y: -2.5, z: 83.5 },
  location: 'exterior',
  sunAmbientColor: { r: 61 / 255, g: 59 / 255, b: 96 / 255 },
  sunDiffuseColor: { r: 90 / 255, g: 86 / 255, b: 141 / 255 },
  fogColor: { r: 0.5, g: 0.5, b: 0.5 },
  fogStart: 125,
  fogEnd: 500,
  fogStartScalar: 0.25,
  rawFogEnd: 18000,
  interiorFog: { color: [0.5, 0.5, 0.5], start: 125, end: 500 },
  fogRampWeight: 0,
  sunDir: { x: -0.5, y: 0.25, z: -0.83 },
  sidnNight: 0,
  selectedLights: [],
  wmo: null,
  nearbyWmoGroups: [],
  ...overrides,
});

describe('LightingReadouts', () => {
  it('renders nothing without a map light', () => {
    const { container } = render(<LightingReadouts mapLight={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('prints colours as 0-255 bytes so they compare against the DBC and the reference dumps', () => {
    render(<LightingReadouts mapLight={target()} />);
    expect(screen.getByText(/61, 59, 96/)).toBeInTheDocument();
    expect(screen.getByText(/90, 86, 141/)).toBeInTheDocument();
  });

  it('prints the fog range start-before-end', () => {
    render(<LightingReadouts mapLight={target()} />);
    // The default target's interior fog shares the same 125/500 range (see the interior-fog test
    // below for why), so this scopes the match to the scene "Fog range:" line specifically rather
    // than colliding with "Interior fog range:".
    expect(
      screen.getByText((_content, element) => element?.textContent === 'Fog range: 125 / 500'),
    ).toBeInTheDocument();
  });

  it('shows a dash rather than a wrong number when nothing has been sampled yet', () => {
    render(<LightingReadouts mapLight={target({ sampledPosition: null })} />);
    expect(screen.getByText(/Sampled at: -/)).toBeInTheDocument();
  });

  it('prints the interior fog triple beside the scene one, and the ramp weight', () => {
    const interiorFog = { color: [0.1, 0.2, 0.3] as [number, number, number], start: 10, end: 90 };
    render(<LightingReadouts mapLight={target({ interiorFog, fogRampWeight: 0.42 })} />);
    expect(screen.getByText(/Interior fog colour: 26, 51, 77/)).toBeInTheDocument();
    expect(screen.getByText(/Interior fog range: 10 \/ 90/)).toBeInTheDocument();
    expect(screen.getByText(/Fog ramp weight: 0\.420/)).toBeInTheDocument();
  });

  it('shows the interior fog equal to the scene fog outdoors, before the ramp has engaged', () => {
    render(<LightingReadouts mapLight={target()} />);
    // The default target's interiorFog matches its scene fog -- outdoors, or before the camera-in-WMO
    // ramp has ever engaged, MapLight publishes the scene triple verbatim for both.
    expect(screen.getByText(/Interior fog colour: 128, 128, 128/)).toBeInTheDocument();
    expect(screen.getByText(/Interior fog range: 125 \/ 500/)).toBeInTheDocument();
    expect(screen.getByText(/Fog ramp weight: 0\.000/)).toBeInTheDocument();
  });

  it('lists the selected area lights with their blend weights', () => {
    const selected = [
      { light: { id: 16 }, weight: 0.75, distance: 120.5 },
      { light: { id: 2 }, weight: 0.25, distance: 400.0 },
    ];
    render(<LightingReadouts mapLight={target({ selectedLights: selected })} />);
    expect(screen.getByText(/Area lights: 2/)).toBeInTheDocument();
    expect(screen.getByText(/id 16/)).toBeInTheDocument();
    expect(screen.getByText(/0\.750/)).toBeInTheDocument();
  });

  it('shows a dash for the LightParams id when a fixture omits params entirely', () => {
    const selected = [{ light: { id: 16 }, weight: 0.75, distance: 120.5 }];
    render(<LightingReadouts mapLight={target({ selectedLights: selected })} />);
    expect(screen.getByText(/id 16 · params -/)).toBeInTheDocument();
  });

  it('prints the LightParams id each selected light resolved its bands from', () => {
    const selected = [
      { light: { id: 16, params: [{ id: 165 }] }, weight: 0.75, distance: 120.5 },
      { light: { id: 2, params: [{ id: 42 }] }, weight: 0.25, distance: 400.0 },
    ];
    render(<LightingReadouts mapLight={target({ selectedLights: selected })} />);
    expect(screen.getByText(/id 16 · params 165/)).toBeInTheDocument();
    expect(screen.getByText(/id 2 · params 42/)).toBeInTheDocument();
  });

  it('prints the resolved fog start scalar, before it is multiplied by fogEnd', () => {
    render(<LightingReadouts mapLight={target({ fogStartScalar: -0.5 })} />);
    expect(screen.getByText(/Fog start scalar: -0\.500/)).toBeInTheDocument();
  });

  it('prints the raw fog-end band value beside the scaled one, so a scale bug shows by inspection', () => {
    render(<LightingReadouts mapLight={target({ fogEnd: 500, rawFogEnd: 18000 })} />);
    expect(screen.getByText(/Fog end raw \/ scaled: 18000\.0 \/ 500\.0/)).toBeInTheDocument();
  });
});

describe('LightingReadouts light slots (diagnostic 1)', () => {
  it('shows a dash for slots when a fixture omits lightSlots entirely', () => {
    const selected = [{ light: { id: 16 }, weight: 0.75, distance: 120.5 }];
    render(<LightingReadouts mapLight={target({ selectedLights: selected })} />);
    expect(screen.getByText(/slots: -/)).toBeInTheDocument();
  });

  it('labels all eight Light.dbc slot ids by name, in field order', () => {
    const selected = [
      {
        light: { id: 16, params: [{ id: 165 }], lightSlots: [165, 0, 166, 0, 0, 0, 0, 0] },
        weight: 1,
        distance: 10,
      },
    ];
    render(<LightingReadouts mapLight={target({ selectedLights: selected })} />);
    expect(screen.getByText(/skyFog 165/)).toBeInTheDocument();
    expect(screen.getByText(/water 0/)).toBeInTheDocument();
    expect(screen.getByText(/sunset 166/)).toBeInTheDocument();
    expect(screen.getByText(/reserved7 0/)).toBeInTheDocument();
  });

  it('does not render a dump button when the target has no dumpLightSlotBands', () => {
    render(<LightingReadouts mapLight={target()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('wires the dump button to dumpLightSlotBands, one-shot rather than per-frame', () => {
    const dumpLightSlotBands = jest.fn();
    render(<LightingReadouts mapLight={target({ dumpLightSlotBands })} />);
    const button = screen.getByRole('button', { name: /dump per-slot fog bands/i });
    expect(dumpLightSlotBands).not.toHaveBeenCalled();
    button.click();
    expect(dumpLightSlotBands).toHaveBeenCalledTimes(1);
  });
});

describe('LightingReadouts nearby WMO groups (diagnostic 2)', () => {
  it('shows zero nearby groups outdoors with none loaded', () => {
    render(<LightingReadouts mapLight={target()} />);
    expect(screen.getByText(/Nearby WMO groups: 0/)).toBeInTheDocument();
  });

  it('prints each nearby group\'s raw flags in hex beside its resolved lightingInterior, so a zero-flags group misread as interior is visible', () => {
    const nearbyWmoGroups = [
      {
        name: 'SomeBuilding.wmo',
        groupIndex: 2,
        flags: 0,
        lightingInterior: true,
        distance: 15.2,
        ext: 0,
        int: 8,
        trans: 1,
      },
      {
        name: 'SomeBuilding.wmo',
        groupIndex: 0,
        flags: 0x8,
        lightingInterior: false,
        distance: 30.0,
        ext: 12,
        int: 0,
        trans: 0,
      },
    ];
    render(<LightingReadouts mapLight={target({ nearbyWmoGroups })} />);
    expect(screen.getByText(/Nearby WMO groups: 2/)).toBeInTheDocument();
    expect(screen.getByText(/flags 0x0 · interior true/)).toBeInTheDocument();
    expect(screen.getByText(/flags 0x8 · interior false/)).toBeInTheDocument();
  });
});

describe('LightingReadouts WMO state', () => {
  it('shows a dash when the camera is not in a WMO', () => {
    render(<LightingReadouts mapLight={target({ wmo: null })} />);
    expect(screen.getByText(/WMO: -/)).toBeInTheDocument();
  });

  it('names the claimed WMO group and its batch-class counts', () => {
    const wmo = { name: 'Stormwind_Inn', groupIndex: 3, ext: 12, int: 40, trans: 5 };
    render(<LightingReadouts mapLight={target({ wmo })} />);
    expect(screen.getByText(/Stormwind_Inn/)).toBeInTheDocument();
    expect(screen.getByText(/group 3/)).toBeInTheDocument();
    expect(screen.getByText(/ext 12/)).toBeInTheDocument();
    expect(screen.getByText(/int 40/)).toBeInTheDocument();
    expect(screen.getByText(/trans 5/)).toBeInTheDocument();
  });
});
