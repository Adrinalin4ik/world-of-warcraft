import * as EasyMediasoup from 'easy-mediasoup-v3-client';
import { Subject } from 'rxjs';
import Peer from './peer';
import Player from '../../classes/player';
import World from '../../world';

export default class Webrtc {
  public messages: Subject<string> = new Subject();
  public peers: Map<string, Peer> = new Map();
  private em: any;
  private config = {
    autorun: true,
    roomId: "1",
    peerId: (Math.random() * 1000).toFixed(3),
    displayName: "test",
    customData: {
      fname: "John",
      lname: 'Travolta'
    },
    // media_server_wss:"wss://v3mediasoup.org:3444",
    media_server_wss: "ws://localhost:4443",
    produce: true,
    consume: true,
    externalVideo: false,
    initial_cam_muted: true,
    initial_mic_muted: true,
    datachannel: true,
    video_constrains: {
      qvga: { width: 50 },
      vga: { width: 100 },
      hd: { width: 320 }
    },
    useSharingSimulcast: false,
    useSimulcast: true,
    video_encodings: [
      { maxBitrate: 100000, scaleResolutionDownBy: 4 },
      { maxBitrate: 300000, scaleResolutionDownBy: 2 },
      { maxBitrate: 1500000, scaleResolutionDownBy: 1 }
    ],
    canvasShareFPS: 25
  };

  private world: World;
  constructor(world: World) {
    this.world = world;
  }
  connect() {
    this.em = new EasyMediasoup.Init(this.config);
    (<any>window).em = this.em;
    (<any>window).webrtc = this;
    this.em.emitter.on('SET_ROOM_STATE', (state: string) => {
      //new/connecting/connected/disconnected/closed
      console.log("SET_ROOM_STATE", state)
    })

    this.em.emitter.on('peerAdded', (params: { id: string }) => {
      console.log('peerAdded', params)

      const player = new Player("TestName", params.id);
      const pos = this.world.player.position.clone();
      player.worldport(this.world.player.mapId!, [pos.x, pos.y, pos.z])
      this.world.add(player);

      this.peers.set(params.id, new Peer({
        id: params.id,
        player
      }))


    });

    this.em.emitter.on('peerRemoved', (id: string) => {
      console.log('peerRemoved', id)
      const peer = this.peers.get(id)
      if (peer) {
        this.world.remove(peer.player)
        this.peers.delete(id);
      }
    });

    this.em.emitter.on('onDataMessage', (message: string) => {
      this.messages.next(message);
    })
  }
}