import { OrderKey, compareOrder } from '../order';

const key = (over: Partial<OrderKey> = {}): OrderKey => ({
  strata: 'MEDIUM',
  frameLevel: 0,
  layer: 'ARTWORK',
  isFontString: false,
  linkStamp: 0,
  declarationSeq: 0,
  ...over,
});

describe('compareOrder', () => {
  it('sorts by strata, then level, then layer, then font strings, then link stamp, then declaration', () => {
    const entries: Array<[string, Partial<OrderKey>]> = [
      // rank 3+4: within one (strata, level) bucket the LAYER outranks the frame, and every texture
      // of a layer precedes every font string of it -- across frames, not grouped per frame.
      ['b.artwork.text', { linkStamp: 1, layer: 'ARTWORK', isFontString: true }],
      ['a.artwork.tex', { linkStamp: 0, layer: 'ARTWORK' }],
      ['b.background', { linkStamp: 1, layer: 'BACKGROUND' }],
      ['a.artwork.text', { linkStamp: 0, layer: 'ARTWORK', isFontString: true }],
      ['b.artwork.tex', { linkStamp: 1, layer: 'ARTWORK' }],
      // rank 6: two regions of one frame keep their declaration order.
      ['a.background.second', { linkStamp: 0, layer: 'BACKGROUND', declarationSeq: 1 }],
      ['a.background.first', { linkStamp: 0, layer: 'BACKGROUND', declarationSeq: 0 }],
      // rank 2: a higher frame level beats every layer of a lower one.
      ['level1.background', { frameLevel: 1, layer: 'BACKGROUND', linkStamp: 9 }],
      // rank 1: strata beats everything, including a higher level and the topmost layer.
      ['dialog.background', { strata: 'DIALOG', layer: 'BACKGROUND', linkStamp: 9 }],
      ['medium.highlight', { frameLevel: 0, layer: 'HIGHLIGHT', linkStamp: 9 }],
    ];

    const sorted = entries
      .map(([label, over]) => ({ label, k: key(over) }))
      .sort((a, b) => compareOrder(a.k, b.k))
      .map((e) => e.label);

    expect(sorted).toEqual([
      'a.background.first',
      'a.background.second',
      'b.background',
      'a.artwork.tex',
      'b.artwork.tex',
      'a.artwork.text',
      'b.artwork.text',
      'medium.highlight',
      'level1.background',
      'dialog.background',
    ]);
  });
});
