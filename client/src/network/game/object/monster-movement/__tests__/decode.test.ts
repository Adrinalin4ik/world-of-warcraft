/**
 * A REAL `SMSG_MONSTER_MOVE`, captured off `logon.gladewow.ru` during a world entry as `Gesf` at
 * Northshire, decoded into a path and a timing -- and then walked.
 *
 * This is the one assertion the movement task is worth having, and it is deliberately a recorded
 * packet rather than a hand-built one. Every wire defect this project has hit was a field that was
 * correct by documentation and wrong on this server's wire, and a fixture assembled from the same
 * belief as the decoder cannot catch that. These 205 bytes came off the socket.
 *
 * What it pins, and each of these was wrong or absent before:
 *  - the body is consumed EXACTLY -- the assertion is implicit in the decode returning at all, since
 *    `readMonsterMove` drops any packet no known tail layout fits byte-for-byte;
 *  - the packed offsets are `midpoint - offset`, not `midpoint + offset` (the old handler) and not
 *    relative to the destination. 42 points come out, and the reconstructed polyline is 160.5 yd
 *    long against a 62.5 yd chord -- a patrol route, not a straight line;
 *  - the DURATION is the packet's, 22936 ms, giving 7.0 yd/s, which is the 3.3.5a creature run
 *    speed. The previous follower advanced its curve parameter by `delta / moveSpeed / 4` and never
 *    read a duration at all;
 *  - the walk ENDS at the server's destination, exactly, not near it.
 */
import Packet from '../../../../net/packet';
import * as THREE from 'three';
import { makeSplineRide, sampleSpline } from '../../../../../game/movement/net-motion';
import { readMonsterMove } from '../decode';
import { movementInfoSize, readMovementInfo, writeMovementInfo } from '../../../movement-info';

/**
 * The captured packet, header stripped. A 41-segment patrol for creature guid `0x3f13`, spline id
 * 68442836, move type 0 (no final facing), spline flags 0, duration 22936 ms.
 */
const RECORDED = '03133f00012d0bc659c425c3b7e0a342d45a14040000000000985900002900000029330ac6'
  + 'ae0760c3ec16a44278e83b0074683b0079f03a007d703a0082f83900868039008b00390081a0780072d078016300'
  + '7901542879014558f9003688f90027b8790118e0f90109103a02fb47fa01ed7ffa01e1d7fa01d5273b02c97f3b02'
  + 'bdd73b02b127fc01a57ffc0199cffc018d27fd018387fd0179efbd016e4fbe0169c77e01643fff0067bfbf006b2f'
  + '00006eafc0ff722f81ff75a7c1ff7927c2ff7c9f0200801f0300839f0300';

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; ++i) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

describe('SMSG_MONSTER_MOVE', () => {
  it('decodes a recorded patrol into its path and its timing, and walks it to the destination', () => {
    const move = readMonsterMove(new Packet(0x0dd, bytes(RECORDED), false));
    expect(move).not.toBeNull();
    const decoded = move!;

    expect(decoded.guid).toBe('0x3f13');
    expect(decoded.stop).toBe(false);
    expect(decoded.flying).toBe(false);
    expect(decoded.durationMs).toBe(22936);
    expect(decoded.path).toHaveLength(42);

    // The path starts where the packet says the unit is and ends at the wire destination.
    expect(decoded.path[0].x).toBeCloseTo(-8907.251, 2);
    expect(decoded.path[0].y).toBeCloseTo(-165.767, 2);
    expect(decoded.path[41].x).toBeCloseTo(-8844.79, 2);
    expect(decoded.path[41].y).toBeCloseTo(-224.03, 2);

    const ride = makeSplineRide(decoded.path, decoded.durationMs, decoded.flying, 0)!;
    expect(ride.total).toBeCloseTo(160.484, 2);
    // Length over duration: the creature run speed. A wrong offset anchor gives 4.1 or 5.1 here.
    expect(ride.total / (decoded.durationMs / 1000)).toBeCloseTo(7.0, 1);

    // Half the DURATION is half the ARC LENGTH -- constant speed, not constant parameter.
    const out = new THREE.Vector3();
    const half = sampleSpline(ride, 22936 / 2, out);
    expect(half.done).toBe(false);
    expect(out.x).toBeCloseTo(-8865.116, 2);
    expect(out.y).toBeCloseTo(-156.04, 2);

    // And the walk ends at the server's destination, exactly.
    const end = sampleSpline(ride, 22936, out);
    expect(end.done).toBe(true);
    expect(out.x).toBeCloseTo(decoded.path[41].x, 5);
    expect(out.y).toBeCloseTo(decoded.path[41].y, 5);
    expect(out.z).toBeCloseTo(decoded.path[41].z, 5);
  });

  /**
   * The OUTBOUND half, as a round trip through the same `MovementInfo` codec the server uses to read
   * it. What this pins is the field WIDTHS: the previous writer put a single byte where the wire
   * wants a uint16 `flags2` and wrote no timestamp at all, so every field from the third on was
   * misaligned and the server could never have read a position out of it. A falling packet is used
   * because the jump block is the optional arm that has to be present exactly when the flag is.
   */
  it('writes an outbound movement body the inbound reader can read back', () => {
    const MOVEFLAG_FALLING = 0x00001000;
    // The EXACT size, which is the point: an outgoing `GamePacket` is fixed-length and
    // `GameHandler#send` declares its ALLOCATED length as the body size, so slack is sent as
    // payload. `writeMovementInfo` must fill `movementInfoSize` to the byte.
    const size = movementInfoSize('0x3f13', MOVEFLAG_FALLING);
    const out = new Packet(0x0bb, size, true);
    out.index = 0;
    writeMovementInfo(out, {
      guid: '0x3f13',
      flags: MOVEFLAG_FALLING,
      timeStamp: 123456,
      x: -8949.95,
      y: -132.493,
      z: 83.5312,
      facing: 1.25,
      fallTime: 700,
      fallVelocity: -7.9556,
      fallSinAngle: 0.5,
      fallCosAngle: 0.8660254,
      fallSpeed: 4.5,
    });

    expect(out.index).toBe(size);
    const written = new Uint8Array(out.buffer as ArrayBuffer, 0, out.index);
    const back = readMovementInfo(new Packet(0x0bb, written, false));
    expect(back.guid).toBe('0x3f13');
    expect(back.flags).toBe(MOVEFLAG_FALLING);
    expect(back.timeStamp).toBe(123456);
    expect(back.x).toBeCloseTo(-8949.95, 2);
    expect(back.facing).toBeCloseTo(1.25, 4);
    expect(back.fallTime).toBe(700);
    expect(back.fallSpeed).toBeCloseTo(4.5, 4);
  });
});
