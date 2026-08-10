import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import CollisionControls, { CollisionControlsTarget } from '../collision-controls';
import { CollisionLayer } from '../../../../game/collision/types';

// A stand-in for CollisionDebugView carrying only what the section reads and writes. The real one
// builds a THREE.LineSegments and gathers from the process-wide collision world -- neither of which
// a checkbox test should need.
const makeView = (
  overrides: Partial<CollisionControlsTarget> = {},
): CollisionControlsTarget & { invalidate: jest.Mock } => ({
  enabled: false,
  xray: true,
  radius: 25,
  layer: CollisionLayer.Walk,
  counts: {
    terrain: 0,
    wmo: 0,
    doodad: 0,
    total: 0,
    registeredChunks: 0,
    registeredWmoGroups: 0,
    registeredHulls: 0,
  },
  ...overrides,
  invalidate: jest.fn(),
});

describe('CollisionControls', () => {
  it('says so rather than throwing when there is no world yet', () => {
    render(<CollisionControls view={null} />);
    expect(screen.getByText(/no world yet/i)).toBeTruthy();
  });

  it('turns the overlay on', () => {
    const view = makeView();
    render(<CollisionControls view={view} />);

    fireEvent.click(screen.getByLabelText(/show collision geometry/i));

    expect(view.enabled).toBe(true);
  });

  it('turns the overlay back off', () => {
    const view = makeView({ enabled: true });
    render(<CollisionControls view={view} />);

    fireEvent.click(screen.getByLabelText(/show collision geometry/i));

    expect(view.enabled).toBe(false);
  });

  it('drives x-ray', () => {
    const view = makeView({ enabled: true, xray: true });
    render(<CollisionControls view={view} />);

    fireEvent.click(screen.getByLabelText(/x-ray/i));

    expect(view.xray).toBe(false);
  });

  it('switches the audience to the camera face set', () => {
    // Walk drops MOPY DETAIL, camera drops NOCAMCOLLIDE -- the two sets genuinely differ, and being
    // able to flip is what separates a camera complaint from a movement one.
    const view = makeView({ enabled: true });
    render(<CollisionControls view={view} />);

    fireEvent.change(screen.getByDisplayValue(/walk/i), {
      target: { value: CollisionLayer.Camera },
    });

    expect(view.layer).toBe(CollisionLayer.Camera);
  });

  it('changes the gather radius as a number, not a string', () => {
    const view = makeView({ enabled: true });
    render(<CollisionControls view={view} />);

    fireEvent.change(screen.getByDisplayValue('25 yd'), { target: { value: '50' } });

    expect(view.radius).toBe(50);
  });

  it('forces a rebuild on demand', () => {
    const view = makeView({ enabled: true });
    render(<CollisionControls view={view} />);

    fireEvent.click(screen.getByRole('button', { name: /rebuild/i }));

    expect(view.invalidate).toHaveBeenCalled();
  });

  it('shows the gathered counts split by provider', () => {
    const view = makeView({
      enabled: true,
      counts: {
        terrain: 24,
        wmo: 776,
        doodad: 0,
        total: 800,
        registeredChunks: 9,
        registeredWmoGroups: 41,
        registeredHulls: 2528,
      },
    });
    render(<CollisionControls view={view} />);

    expect(screen.getByText(/terrain: 24/)).toBeTruthy();
    expect(screen.getByText(/wmo: 776/)).toBeTruthy();
    // The exact reading that went unnoticed for a long time: hulls registered, none gathered.
    expect(screen.getByText(/doodads: 0/)).toBeTruthy();
    expect(screen.getByText(/m2 hulls: 2528/)).toBeTruthy();
  });

  it('disables the sub-controls while the overlay is off', () => {
    const view = makeView({ enabled: false });
    render(<CollisionControls view={view} />);

    expect((screen.getByRole('button', { name: /rebuild/i }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByLabelText(/x-ray/i) as HTMLInputElement).disabled).toBe(true);
  });
});
