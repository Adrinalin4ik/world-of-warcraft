import WorkerPool from '../../../worker/pool';
import WMOGroup from '../';
import gameSettings  from '../../../../settings';

class WMOGroupLoader {

  static cache = new Map();

  static refCounts = new Map();
  static pendingUnload = new Set();
  static unloaderRunning = false;

  static UNLOAD_INTERVAL = gameSettings.wmo.unloadInterval;

  static load(root, index, rawPath) {
    const path = rawPath.toUpperCase();

    // Prevent unintended unloading.
    if (this.pendingUnload.has(path)) {
      this.pendingUnload.delete(path);
    }

    // Background unloader might need to be started.
    if (!this.unloaderRunning) {
      this.unloaderRunning = true;
      this.backgroundUnload();
    }

    // Keep track of references.
    const refCount = (this.refCounts.get(path) || 0) + 1;
    this.refCounts.set(path, refCount);
    if (!this.cache.has(path)) {
      const worker = WorkerPool.enqueue('WMOGroup', path, index, root.header);

      const promise = worker.then((def) => {
        return new WMOGroup(root, def);
      });

      this.cache.set(path, promise);
    }
    
    const group = this.cache.get(path);

    return group;
  }

  static loadByIndex(root, index) {
    const suffix = `000${index}`.slice(-3);
    const path = root.path.replace(/\.wmo/i, `_${suffix}.wmo`);

    return this.load(root, index, path);
  }

  static unload(group) {
    const path = group.path.toUpperCase();
    // Colliders are NOT removed here any more. A group is cached by path and shared by every
    // placement, while a collider belongs to a PLACEMENT's view -- so this removed one arbitrary
    // view's collider whenever any placement streamed out, and unconditionally, ignoring the refcount
    // just below. `WMO#unload` removes the views it owns instead.
    const refCount = (this.refCounts.get(path) || 1) - 1;

    if (refCount <= 0) {
      this.pendingUnload.add(path);
    } else {
      this.refCounts.set(path, refCount);
    }
  }

  static backgroundUnload() {
    for (const path of this.pendingUnload) {
      if (this.cache.has(path)) {
        this.cache.get(path).then((group) => {
          group.dispose();
        });
      }

      this.cache.delete(path);
      this.refCounts.delete(path);
      this.pendingUnload.delete(path);
    }

    setTimeout(this.backgroundUnload.bind(this), this.UNLOAD_INTERVAL);
  }

}

export default WMOGroupLoader;
