/** @jest-environment node */
import EventEmitter from 'events';
import ByteBuffer from 'byte-buffer';
import Socket from '../../../net/socket';
import { createSocketLogonIo } from '../logon';

/**
 * `createSocketLogonIo` is the one function in `logon.ts` no other test drives, which is exactly
 * why a real bug lived here: `read()` returns a NEW ByteBuffer wrapping a slice, not raw bytes, so
 * `new Uint8Array(read(...))` silently produced an empty array on every message. Feeding a fake
 * socket a `data:receive` with known bytes and asserting the listener sees exactly those bytes is
 * the test that would have caught it.
 */
class FakeSocket extends EventEmitter {
  buffer: ByteBuffer;
  socket: { send: jest.Mock };

  constructor(bytes: number[]) {
    super();
    this.buffer = new ByteBuffer(new Uint8Array(bytes).buffer, ByteBuffer.LITTLE_ENDIAN);
    this.socket = { send: jest.fn() };
  }

  connect = jest.fn();
  disconnect = jest.fn();
}

describe('createSocketLogonIo', () => {
  it('delivers the exact bytes read off the socket buffer to onMessage listeners', () => {
    const fakeSocket = new FakeSocket([0xaa, 0xbb, 0xcc, 0x00, 0xff]);
    const io = createSocketLogonIo(fakeSocket as unknown as Socket);

    const received: Uint8Array[] = [];
    io.onMessage((bytes) => received.push(bytes));

    fakeSocket.emit('data:receive');

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0])).toEqual([0xaa, 0xbb, 0xcc, 0x00, 0xff]);
  });

  it('sends bytes through the underlying WebSocket', () => {
    const fakeSocket = new FakeSocket([]);
    const io = createSocketLogonIo(fakeSocket as unknown as Socket);

    const bytes = new Uint8Array([1, 2, 3]);
    io.send(bytes);

    expect(fakeSocket.socket.send).toHaveBeenCalledWith(bytes);
  });

  it('disconnects the underlying socket on close', () => {
    const fakeSocket = new FakeSocket([]);
    const io = createSocketLogonIo(fakeSocket as unknown as Socket);

    io.close();

    expect(fakeSocket.disconnect).toHaveBeenCalled();
  });
});
