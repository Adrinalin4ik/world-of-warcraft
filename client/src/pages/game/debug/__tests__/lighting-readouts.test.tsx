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
  sunDir: { x: -0.5, y: 0.25, z: -0.83 },
  sidnNight: 0,
  selectedLights: [],
  wmoPointLights: [],
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
    expect(screen.getByText(/125 \/ 500/)).toBeInTheDocument();
  });

  it('shows a dash rather than a wrong number when nothing has been sampled yet', () => {
    render(<LightingReadouts mapLight={target({ sampledPosition: null })} />);
    expect(screen.getByText(/Sampled at: -/)).toBeInTheDocument();
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
