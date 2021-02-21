import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import geckos from '@geckos.io/server';

async function bootstrap() {
  const io = geckos();
  const app = await NestFactory.create(AppModule);
  const players = [];
  io.addServer(app.getHttpServer());
  io.onConnection(channel => {
    let currentPlayerId = null;
    // the channel's id and maxMessageSize (in bytes)
    const { id, maxMessageSize } = channel
    console.log(channel);
    // whenever the channel got disconnected
    // the reason will be 'disconnected', 'failed' or 'closed'
    channel.onDisconnect(data => {
      console.log('onDisconnect', data);
      const index = players.findIndex(id => id === currentPlayerId);
      players.splice(index, 1);
      channel.room.emit('removePlayer', currentPlayerId)
    });
  
    // listen for a custom event
    channel.on('move', data => {
      console.log(data);
    });

    channel.on('data', data => {
      console.log(data);
      channel.broadcast.emit('data', data);
    });

    channel.on('join', (id) => {
      console.log(id)
      currentPlayerId = id
      channel.emit('playerList', players);
      channel.broadcast.emit('addPlayer', { id });
      players.push(id);
    });
  
    // channel joins a room
    channel.join('1')
  
    // channel leaves a room
    // channel.leave()
  
    // channel closes the webRTC connection
    // channel.close()
  
    // get notified when a message got dropped
    // channel.onDrop(drop => {})
  
    // will trigger a specific event on all channels in a
    // specific room and add the senderId as a second parameter
    // channel.forward(channel.roomId).emit('chat message', 'Hello!')
  
    // listen for a forwarded message

  
    // emits a message to the channel
    // channel.emit('chat message', 'Hello to myself!')
  
    // // emits a message to all channels, in the same room
    // channel.room.emit('chat message', 'Hello everyone!')
  
    // // emits a message to all channels, in the same room, except sender
    // channel.broadcast.emit('chat message', 'Hello friends!')
  
    // // emits a message to all channels
    // io.emit('chat message', 'Hello everyone!')
  
    // // emits a message to all channels in a specific room
    // // (if you do not pass a roomId, the message will be sent to everyone who is not in a room yet)
    // io.room(channel.roomId).emit('chat message', 'Hello everyone!')
  })
  await app.listen(3001);
}
bootstrap();
