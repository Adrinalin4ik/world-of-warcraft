/**
 * The keepalive floor: two `CMSG_PING`s less than 27 s apart must produce ONE packet.
 *
 * This is the one seam worth a test on this path, and for the reason `PING_MIN_GAP_MS` states -- the
 * failure it prevents is a server-side kick two seconds later with no error, no reason and no
 * `SMSG_PONG`, which is exactly the shape of bug that looks like "the connection is just flaky".
 *
 * Called through the prototype on a stub rather than on a real `GameHandler`: the constructor builds
 * a `World`, and this is a question about a timer, not about a scene.
 */
import { GameHandler } from '../handler';
import GameOpcode from '../opcode';

interface PingStub {
  pingRecv: boolean;
  lastPingAt: number | null;
  sent: number[];
  send(packet: { opcode: number }): boolean;
  stopPing(): void;
  disconnect(): void;
}

function stub(): PingStub {
  return {
    pingRecv: true,
    lastPingAt: null,
    sent: [],
    send(packet) {
      this.sent.push(packet.opcode);
      return true;
    },
    stopPing() {},
    disconnect() {},
  };
}

const ping = (self: PingStub) => (GameHandler.prototype as unknown as { ping(): void }).ping.call(self);

describe('GameHandler#ping', () => {
  it('sends one ping, then suppresses a second inside the 27 s overspeed floor', () => {
    const now = jest.spyOn(performance, 'now');
    const self = stub();

    now.mockReturnValue(0);
    ping(self);
    expect(self.sent).toEqual([GameOpcode.CMSG_PING]);

    // 26.9 s later: inside the floor, so nothing goes out -- and `pingRecv` is left alone, because a
    // packet that was never sent has no pong to wait for.
    self.pingRecv = true;
    now.mockReturnValue(26900);
    ping(self);
    expect(self.sent).toEqual([GameOpcode.CMSG_PING]);
    expect(self.pingRecv).toBe(true);

    // 27.1 s: past the floor, so the keepalive resumes.
    now.mockReturnValue(27100);
    ping(self);
    expect(self.sent).toEqual([GameOpcode.CMSG_PING, GameOpcode.CMSG_PING]);

    now.mockRestore();
  });
});
