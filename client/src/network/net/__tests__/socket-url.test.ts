import Socket from '../socket';
import { DEFAULT_SETTINGS, saveSettings } from '../../protocol/connection-settings';

/**
 * The one test of what URL this client actually opens.
 *
 * Until this existed the socket built `ws://<target-host>:<target-port>`, i.e. it opened a WebSocket
 * straight at the game's raw TCP port, which has no WebSocket listener on it and could never connect
 * to any server. The URL now names the target to the gateway instead, and the gateway URL is allowed
 * to carry a path (a deployment behind one reverse proxy), so the join must not double the slash.
 */
class FakeWebSocket {
  static OPEN = 1;
  static url: string | null = null;

  readyState = 0;
  binaryType = '';

  constructor(url: string) {
    FakeWebSocket.url = url;
  }

  close(): void {
    /* nothing to tear down */
  }
}

describe('Socket#connect', () => {
  const realWebSocket = (global as any).WebSocket;

  beforeAll(() => {
    (global as any).WebSocket = FakeWebSocket;
  });

  afterAll(() => {
    (global as any).WebSocket = realWebSocket;
  });

  it('opens the gateway with the TCP target in the path, not the game port itself', () => {
    saveSettings({ ...DEFAULT_SETTINGS, gatewayUrl: 'ws://gw.example.com:9000/relay/' });

    const socket = new Socket().connect('logon.example.com', 3724);

    expect(socket.uri).toBe('ws://gw.example.com:9000/relay/tcp/logon.example.com:3724');
    expect(FakeWebSocket.url).toBe(socket.uri);
  });
});
