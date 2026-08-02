import { render, screen } from '@testing-library/react';
import React from 'react';

import { moveTrace } from '../../../../game/movement/move-trace';
import MoveReadout from '../move-readout';

beforeEach(() => {
  moveTrace.clear();
  moveTrace.enabled = true;
});

afterAll(() => {
  moveTrace.enabled = false;
  moveTrace.clear();
});

const frame = (over: Partial<Parameters<typeof moveTrace.frame>[0]> = {}) => ({
  zIn: 0,
  zOut: 0,
  grounded: true,
  onWalkable: true,
  velZ: 0,
  snap: null,
  climb: null,
  stepUpVerdict: null,
  ...over,
});

test('says the trace is off rather than rendering blanks', () => {
  moveTrace.enabled = false;
  render(<MoveReadout />);

  expect(screen.getByText(/trace off/i)).toBeInTheDocument();
});

test('says so when recording but nothing has happened yet', () => {
  render(<MoveReadout />);

  expect(screen.getByText(/no frames yet/i)).toBeInTheDocument();
});

test('shows the latest frame probe numbers', () => {
  moveTrace.frame(frame({
    zIn: 12.5, zOut: 12.25, snap: { reach: 3.1, hit: { distance: 0.25, normalZ: 0.98 } },
  }));

  render(<MoveReadout />);

  expect(screen.getByText(/grounded/i)).toBeInTheDocument();
  expect(screen.getByText(/3\.10/)).toBeInTheDocument();
  expect(screen.getByText(/0\.25/)).toBeInTheDocument();
});

test('surfaces the step-up verdict, which is the whole diagnosis of a stuck report', () => {
  moveTrace.frame(frame({ stepUpVerdict: 'steep-floor' }));

  render(<MoveReadout />);

  expect(screen.getByText(/steep-floor/)).toBeInTheDocument();
});

test('renders a missed snap probe as a miss, not as zero', () => {
  // "reach 3.10, hit none" is a fall about to start; "reach 3.10, hit at 0.00" is standing on the
  // floor. They mean opposite things.
  moveTrace.frame(frame({
    grounded: false, onWalkable: false, velZ: -5, snap: { reach: 3.1, hit: null },
  }));

  render(<MoveReadout />);

  expect(screen.getByText(/none/i)).toBeInTheDocument();
  expect(screen.getByText(/airborne/i)).toBeInTheDocument();
});

test('reports when the step-up took the frame instead of the snap', () => {
  moveTrace.frame(frame({ snap: null, climb: 0.312, stepUpVerdict: 'commit' }));

  render(<MoveReadout />);

  expect(screen.getByText(/skipped/i)).toBeInTheDocument();
  expect(screen.getByText(/0\.312/)).toBeInTheDocument();
});
