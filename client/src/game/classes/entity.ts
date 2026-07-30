import EventEmitter from 'events';

class Entity extends EventEmitter {
  public guid: string = (Math.random() * 1000000).toString();
}

export default Entity;