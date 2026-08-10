import geckos, { ClientChannel } from '@geckos.io/client';
import Player from '../../classes/player';
import World from '../../world';
import { MessageHandler } from './message_handler';
import Peer from './peer';

export default class Webrtc {
  public peers: Map<string, Peer> = new Map();
  public peerId: string = (Math.random() * 1000000).toFixed(0);
  private world: World;
  private channel: ClientChannel = geckos({ port: 3001 });

  constructor(world: World) {
    this.world = world;
    this.world.player.guid = this.peerId;
  }
  connect() {
    this.channel.onConnect(error => {
      console.log("Join", this.channel);
      if (error) {
        console.error(error.message)
        return
      }

      this.channel.emit('join', this.peerId);
    });
    
    this.channel.on('playerList', (data) => {
      console.log('playerList', data)
      const players = data as string[];
      players.forEach(id => {
        this.createPlayer(id);
      });
    });

    this.channel.on('addPlayer', (data) => {
      console.log('addPlayer', data);
      const { id } = data as { id: string};
      console.log('addPlayer', data)
      this.createPlayer(id);
    });

    this.channel.on('removePlayer', (data) => {
      console.log('removePlayer', data)
      const id = data as string;
      console.log('removePlayer', id)
      this.removePlayer(id);
    });

    this.channel.on('data', (data) => {
      const message = data as string;
      console.log(message)
      MessageHandler.handle(message)
    })
  }

  createPlayer(id: string) {
    const peer = this.peers.get(id);
    if (peer) return;
    
    const player = new Player(id, "TestName");
    player.useGravity = false;
    const pos = this.world.player.position.clone();
    player.worldport(this.world.player.mapId!, [pos.x, pos.y, pos.z])
    this.world.add(player);

    this.peers.set(id, new Peer({
      id: id,
      player
    }));
  }

  removePlayer(id: string) {
    const peer = this.peers.get(id)
      if (peer) {
        this.world.remove(peer.player)
        this.peers.delete(id);
      }
  }

  sendMessage(message: string) {
    this.channel.emit('data', message)
  }
}