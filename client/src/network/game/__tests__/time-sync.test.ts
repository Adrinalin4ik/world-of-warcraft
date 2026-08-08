import { TIME_SYNC_RESP_BODY_BYTES, encodeTimeSyncResponse } from '../time-sync';

// The encoding is the whole of this fix: an unanswered SMSG_TIME_SYNC_REQ costs the world session
// after ~60 s, and an answer the server cannot parse would cost it just the same while looking sent.
// Both fields are uint32 LITTLE-endian, counter first -- byte order is the thing worth pinning.
describe('encodeTimeSyncResponse', () => {
  it('writes the echoed counter then the client ticks, both uint32 little-endian', () => {
    const body = encodeTimeSyncResponse(0x04030201, 0x08070605);

    expect(body.length).toBe(TIME_SYNC_RESP_BODY_BYTES);
    expect(Array.from(body)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  });
});
