import React from 'react';

import { moveTrace } from '../../../game/movement/move-trace';

/**
 * The movement trace readout.
 *
 * Feel is not unit-testable, so this is how a "it feels stuck here" report becomes diagnosable: it
 * shows the exact probe numbers and the step-up's verdict for the current frame. Reasoning alone
 * cannot tell a face that was too tall from one whose landing was too steep, and those want
 * opposite fixes.
 *
 * A missed snap probe renders as "none", never as 0. "reach 3.10, hit none" is a fall about to
 * start; "reach 3.10, hit at 0.00" is standing on the floor. Collapsing the two would send a
 * diagnosis in exactly the wrong direction.
 */
export default function MoveReadout() {
  if (!moveTrace.enabled) {
    return (
      <div className="move_readout">
        trace off &mdash; set <code>moveTrace.enabled = true</code> in the console to record
      </div>
    );
  }

  const frame = moveTrace.last();
  if (!frame) {
    return <div className="move_readout">trace on, no frames yet</div>;
  }

  const snap = frame.snap
    ? `reach ${frame.snap.reach.toFixed(2)}, hit ${
      frame.snap.hit
        ? `${frame.snap.hit.distance.toFixed(2)} (n.z ${frame.snap.hit.normalZ.toFixed(2)})`
        : 'none'
    }`
    : 'skipped (step-up took the frame)';

  return (
    <div className="move_readout">
      <div>
        {frame.grounded ? 'grounded' : 'airborne'}
        {frame.onWalkable ? ' / walkable' : ''}
      </div>
      <div>
        z {frame.zIn.toFixed(2)} &rarr; {frame.zOut.toFixed(2)}, vz {frame.velZ.toFixed(2)}
      </div>
      <div>snap: {snap}</div>
      {frame.climb !== null && <div>step-up climb {frame.climb.toFixed(3)}</div>}
      {frame.stepUpVerdict && <div>step-up: {frame.stepUpVerdict}</div>}
    </div>
  );
}
