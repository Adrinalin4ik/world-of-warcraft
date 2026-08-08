import ByteBuffer from 'byte-buffer';
import EventEmitter from 'events';
import { gameSocketUrl } from '../gateway';

// Base-class for any socket including signals and host/port management
class Socket extends EventEmitter {

  // Maximum buffer capacity
  // TODO: Arbitrarily chosen, determine this cap properly
  static BUFFER_CAP = 2048;

  // Creates a new socket
  constructor() {
    super();

    // Holds the host, port and uri currently connected to (if any)
    this.host = null;
    this.port = NaN;
    this.uri = null;

    // Holds the actual socket
    this.socket = null;

    // Holds buffered data
    this.buffer = null;

    // Holds incoming packet's remaining size in bytes (false if no packet is being handled)
    this.remaining = false;
  }

  // Whether this socket is currently connected
  get connected() {
    return this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  // Connects to given host through given port (if any; default port is implementation specific)
  //
  // `host`/`port` name the TCP target -- a logon or realm server. They are NOT what the WebSocket
  // opens: a browser cannot speak TCP, so the socket is opened at the gateway with the target named
  // in the URL. `network/gateway.ts` owns that translation and is the only place that builds a URL.
  connect(host, port = NaN) {
    // A SECOND connect on this wrapper has to actually dial, and until this it did not.
    //
    // The body below used to sit inside `if (!this.connected)`, so a connect on an already-open
    // socket did NOTHING -- silently, and with no return value that could say so. Every caller
    // learns that a connection came up from the `connect` EVENT (`protocol/wotlk/logon.ts:255`,
    // `protocol/wotlk/world.ts:263`), and a socket that is never opened never emits one, so the
    // caller's promise could settle neither way.
    //
    // That is the whole of "a second login hangs". Nothing ever closes the logon socket --
    // `WotlkLogonTransport#close()` exists and has no callers -- so it is still OPEN when the player
    // logs in again, and `authenticate()` then awaited a `connect` event that could not arrive.
    // Measured on a live page against `logon.gladewow.ru`: a first login and world entry, a world
    // disconnect, then a second `ProtocolSession#login` which sat in stage `Authenticating` for the
    // full 25 s timeout with NO third WebSocket constructed at all. We never dialled; the server
    // never refused us, because we never spoke to it.
    //
    // Callers that genuinely want "only if not already up" guard themselves and are unaffected --
    // `AuthHandler#connect` (auth/handler.js:39) and `GameHandler#connect` (game/handler.js:64) both
    // test `this.connected` first. This only changes the case that was broken.
    this.dropSocket();

    this.host = host;
    this.port = port;
    this.uri = gameSocketUrl(this.host, this.port);

    this.buffer = new ByteBuffer(0, ByteBuffer.LITTLE_ENDIAN);
    this.remaining = false;

    // 'binary' is websockify's own contract, which `ws-proxy/server.js` inherited: it answers
    // 'binary' (raw frames) or 'base64', and its relay reads `client.protocol` to decide which. Ask
    // for it explicitly. Offering nothing happens to work only because `ws` skips its
    // `handleProtocols` callback entirely when the client names no subprotocol -- so the gateway's
    // "must offer binary or base64" refusal is bypassed rather than satisfied, and a stricter server
    // or a future `ws` would drop the handshake.
    this.socket = new WebSocket(this.uri, 'binary');
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = (e) => {
      this.emit('connect', e);
    };

    this.socket.onclose = (e) => {
      this.emit('disconnect', e);
    };

    this.socket.onmessage = (e) => {
      const index = this.buffer.index;
      this.buffer.end().append(e.data.byteLength).write(e.data);
      this.buffer.index = index;

      this.emit('data:receive', this);

      if (this.buffer.available === 0 && this.buffer.length > this.constructor.BUFFER_CAP) {
        this.buffer.clip();
      }
    };

    this.socket.onerror = function(e) {
      console.error(e);
    };

    return this;
  }

  // Discards the current socket, if any, without letting it speak again.
  //
  // The handlers come off BEFORE `close()`, and that ordering is the point. A close emits
  // `disconnect` on this wrapper a turn later, and every caller of `connect()` registers its
  // REJECTION on exactly that event immediately beforehand (`logon.ts:256`, `world.ts:264`) -- so a
  // replaced socket would reject the very connect it was replaced for. Detaching first means the
  // outgoing socket's close is nobody's business but the browser's.
  dropSocket() {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = null;
    socket.onopen = null;
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }

  // Attempts to reconnect to cached host and port
  reconnect() {
    if (!this.connected && this.host && this.port) {
      this.connect(this.host, this.port);
    }
    return this;
  }

  // Disconnects this socket
  disconnect() {
    if (this.connected) {
      this.socket.close();
    }
    return this;
  }

  // Finalizes and sends given packet
  send(packet) {
    if (this.connected) {

      packet.finalize();

      console.log('⟸', packet.toString());
      // console.debug packet.toHex()
      // console.debug packet.toASCII()

      this.socket.send(packet.buffer);

      this.emit('packet:send', packet);

      return true;
    }

    return false;
  }

}

export default Socket;
