import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import LightingControls from '../lighting-controls';

// A stand-in for MapLight carrying only what the control touches. Using the real MapLight here would
// drag in three.js, the DBC loader and a network fetch for a slider.
const makeMapLight = (overrides: Partial<{ time: number; timeOverride: number | null }> = {}) => ({
  time: 1440,
  timeOverride: null as number | null,
  ...overrides,
});

describe('LightingControls', () => {
  it('renders nothing without a map light', () => {
    const { container } = render(<LightingControls mapLight={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the current time as hours and minutes', () => {
    // 1440 half-minutes = minute 720 = 12:00.
    render(<LightingControls mapLight={makeMapLight({ time: 1440 })} />);
    expect(screen.getByText(/12:00/)).toBeInTheDocument();
  });

  it('follows the clock until the override checkbox is cleared', () => {
    const mapLight = makeMapLight();
    render(<LightingControls mapLight={mapLight} />);
    const follow = screen.getByLabelText(/follow clock/i) as HTMLInputElement;
    expect(follow.checked).toBe(true);

    fireEvent.click(follow);
    // Taking manual control seeds the override from the time currently displayed, so the light does
    // not jump the instant the box is unticked.
    expect(mapLight.timeOverride).toBe(1440);
  });

  it('writes the slider position into timeOverride in half-minutes', () => {
    const mapLight = makeMapLight({ timeOverride: 1440 });
    render(<LightingControls mapLight={mapLight} />);
    // The slider is in MINUTES; MapLight wants half-minutes.
    fireEvent.change(screen.getByLabelText(/time of day/i), { target: { value: '390' } });
    expect(mapLight.timeOverride).toBe(780);
  });

  it('returns to the clock when the checkbox is re-ticked', () => {
    const mapLight = makeMapLight({ timeOverride: 780 });
    render(<LightingControls mapLight={mapLight} />);
    fireEvent.click(screen.getByLabelText(/follow clock/i));
    expect(mapLight.timeOverride).toBeNull();
  });
});
