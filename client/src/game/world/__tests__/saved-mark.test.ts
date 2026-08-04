/**
 * @jest-environment node
 */
import {
  MarkStorage, SAVED_MARK_KEY, clearMark, readMark, writeMark,
} from '../saved-mark';

/** A localStorage stand-in. Values are strings, exactly as the real one stores them. */
function makeStorage(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };

  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
  };
}

const stored = (mark: object) => ({ [SAVED_MARK_KEY]: JSON.stringify(mark) });

describe('readMark', () => {
  it('reads a well-formed mark', () => {
    expect(readMark(makeStorage(stored({ mapId: 1, x: 2, y: 3, z: 4 }))))
      .toEqual({ mapId: 1, x: 2, y: 3, z: 4 });
  });

  it('returns null when nothing is stored', () => {
    expect(readMark(makeStorage())).toBeNull();
  });

  it('returns null with no storage at all', () => {
    expect(readMark(null)).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', () => {
    // localStorage outlives builds. A mark from an older shape must not take down the startup port.
    expect(readMark(makeStorage({ [SAVED_MARK_KEY]: '{not json' }))).toBeNull();
  });

  it('rejects a mark with a missing or non-numeric field', () => {
    expect(readMark(makeStorage(stored({ mapId: 1, x: 2 })))).toBeNull();
    expect(readMark(makeStorage(stored({ mapId: 1, x: 'a', y: 3, z: 4 })))).toBeNull();
  });

  it('rejects NaN, which JSON.stringify writes as null', () => {
    // A NaN mark would port the player nowhere with the settle hold armed, which reads as a hang.
    expect(readMark(makeStorage(stored({ mapId: 1, x: NaN, y: 3, z: 4 })))).toBeNull();
  });

  it('accepts map 0 and negative coordinates', () => {
    // Map 0 is Eastern Kingdoms and half the world has negative coordinates; a truthiness check here
    // would silently drop both.
    expect(readMark(makeStorage(stored({ mapId: 0, x: -9293, y: -2220, z: 62 }))))
      .toEqual({ mapId: 0, x: -9293, y: -2220, z: 62 });
  });

  it('survives a storage that throws on read', () => {
    const hostile: MarkStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(readMark(hostile)).toBeNull();
  });
});

describe('writeMark', () => {
  it('round-trips through readMark', () => {
    const storage = makeStorage();

    writeMark({ mapId: 489, x: 1310.5, y: 1463.25, z: 317.75 }, storage);

    expect(readMark(storage)).toEqual({ mapId: 489, x: 1310.5, y: 1463.25, z: 317.75 });
  });

  it('does not throw when storage refuses the write', () => {
    const hostile: MarkStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => undefined,
    };

    expect(() => writeMark({ mapId: 1, x: 1, y: 1, z: 1 }, hostile)).not.toThrow();
  });

  it('does not throw with no storage', () => {
    expect(() => writeMark({ mapId: 1, x: 1, y: 1, z: 1 }, null)).not.toThrow();
  });
});

describe('clearMark', () => {
  it('removes the mark', () => {
    const storage = makeStorage(stored({ mapId: 1, x: 2, y: 3, z: 4 }));

    clearMark(storage);

    expect(readMark(storage)).toBeNull();
  });

  it('does not throw when storage refuses the removal', () => {
    const hostile: MarkStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => { throw new Error('blocked'); },
    };

    expect(() => clearMark(hostile)).not.toThrow();
  });
});
