/** @jest-environment node */
import { GpuTimer } from '../gpu-timer';

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT_AVAILABLE = 0x8867;
const QUERY_RESULT = 0x8866;

interface FakeQuery { id: number; nanos: number }

/** A minimal stand-in for the WebGL2 timer-query surface this class touches. */
function fakeGl(options: { supported?: boolean; disjoint?: boolean } = {}) {
  const { supported = true, disjoint = false } = options;
  let nextId = 1;
  const deleted: number[] = [];
  const ext = { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT };

  const gl: any = {
    QUERY_RESULT_AVAILABLE,
    QUERY_RESULT,
    deleted,
    resolve: null as null | FakeQuery,
    getExtension: (name: string) =>
      supported && name === 'EXT_disjoint_timer_query_webgl2' ? ext : null,
    createQuery: () => ({ id: nextId++, nanos: 0 } as FakeQuery),
    beginQuery: jest.fn(),
    endQuery: jest.fn(),
    deleteQuery: (q: FakeQuery) => deleted.push(q.id),
    getParameter: (pname: number) => (pname === GPU_DISJOINT_EXT ? disjoint : 0),
    getQueryParameter: (q: FakeQuery, pname: number) => {
      if (pname === QUERY_RESULT_AVAILABLE) return gl.resolve?.id === q.id;
      if (pname === QUERY_RESULT) return q.nanos;
      return 0;
    },
  };
  return gl;
}

describe('GpuTimer.create', () => {
  it('returns null when the extension is unavailable', () => {
    expect(GpuTimer.create(fakeGl({ supported: false }))).toBeNull();
  });

  it('returns a timer when the extension is present', () => {
    expect(GpuTimer.create(fakeGl())).toBeInstanceOf(GpuTimer);
  });
});

describe('GpuTimer', () => {
  it('returns null while the query has not resolved', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.end();
    expect(timer.poll()).toBeNull();
  });

  it('converts a resolved query from nanoseconds to milliseconds', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.end();
    const pending = gl.beginQuery.mock.calls[0][1];
    pending.nanos = 4_500_000;
    gl.resolve = pending;
    expect(timer.poll()).toBeCloseTo(4.5, 6);
  });

  it('discards a disjoint result rather than reporting a bogus time', () => {
    const gl = fakeGl({ disjoint: true });
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.end();
    const pending = gl.beginQuery.mock.calls[0][1];
    pending.nanos = 99_000_000;
    gl.resolve = pending;
    expect(timer.poll()).toBeNull();
    expect(gl.deleted).toContain(pending.id);
  });

  it('ignores a second begin() while one query is already open', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.begin();
    expect(gl.beginQuery).toHaveBeenCalledTimes(1);
  });

  it('ignores end() with no open query', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.end();
    expect(gl.endQuery).not.toHaveBeenCalled();
  });

  it('bounds the pending queue rather than leaking queries that never resolve', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    for (let i = 0; i < 20; ++i) {
      timer.begin();
      timer.end();
      timer.poll();
    }
    // 20 issued, at most MAX_PENDING retained, the rest deleted.
    expect(gl.deleted.length).toBeGreaterThanOrEqual(20 - 8);
  });
});
