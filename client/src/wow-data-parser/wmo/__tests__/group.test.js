import GroupChunk from '../group';

// GroupChunk is a restructure Struct built by Chunked(); its computed fields (functions of
// `this.flags`) live on `.fields` and can be exercised directly without decoding a real buffer.
const exterior = GroupChunk.fields.exterior;

describe('WMO group exterior', () => {
  it('is true when MOGP flag 0x8 (EXTERIOR) is set', () => {
    expect(exterior.call({ flags: 0x0008 })).toBe(true);
    expect(exterior.call({ flags: 0x2008 })).toBe(true);
  });

  it('is false when MOGP flag 0x8 is not set', () => {
    expect(exterior.call({ flags: 0x0000 })).toBe(false);
    expect(exterior.call({ flags: 0x2000 })).toBe(false);
  });
});
