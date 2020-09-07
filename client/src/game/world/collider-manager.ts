import { ExtendedObject3D } from 'enable3d';

export enum ColliderManagerSubType {
  add,
  remove
}

export interface IColliderManagerSubscription {
  id: string,
  type: ColliderManagerSubType,
  callback: Function,
  unsubscribe: Function
}

class ColliderManager {
  static collidableMeshList = new Map<string, ExtendedObject3D>();
  static subscriptions: IColliderManagerSubscription[] = []
  static add(id: string, object: ExtendedObject3D) {
    ColliderManager.collidableMeshList.set(id, object);
    this.subscriptions.filter(x => x.type === ColliderManagerSubType.add).forEach(x => x.callback(object));
  }

  static remove(id: string) {
    ColliderManager.collidableMeshList.delete(id);
    this.subscriptions.filter(x => x.type === ColliderManagerSubType.remove).forEach(x => x.callback(id));
  }

  static subscribe(type: ColliderManagerSubType, callback: Function) {
    const id = (Math.random() * 1e6).toFixed(0);
    ColliderManager.subscriptions.push({
      id: id,
      type,
      callback,
      unsubscribe: ColliderManager.unsubscribe.bind(this, id)
    })
  }

  static unsubscribe(id: string) {
    const subIndex = ColliderManager.subscriptions.findIndex(x => x.id === id);
    if (subIndex !== -1) {
      ColliderManager.subscriptions.splice(subIndex, 1);
    }
  }
}

export default ColliderManager;
