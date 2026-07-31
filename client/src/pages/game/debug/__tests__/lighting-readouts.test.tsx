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
  interiorFog: { color: [0.5, 0.5, 0.5], start: 125, end: 500 },
  fogRampWeight: 0,
  sunDir: { x: -0.5, y: 0.25, z: -0.83 },
  sidnNight: 0,
  selectedLights: [],
  wmo: null,
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
