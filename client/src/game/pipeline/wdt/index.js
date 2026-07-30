import WorkerPool from '../worker/pool';
import WDTLoader from './WDTLoader';
import WDTLoaderLite from './WDTLoaderLite';

class WDT {

  static cache = {};
  static loader = new WDTLoader();
  static loaderLite = new WDTLoaderLite();

  constructor(data) {
    this.data = data;
  }

  static load(path) {
    if (!(path in this.cache)) {
      this.cache[path] = WorkerPool.enqueue('WDT', path).then((args) => {
        const data = args;
        return new this(data);
      });
    }

    return this.cache[path];
  }

  /**
   * Load WDT data using the new loader
   */
  static async loadData(path) {
    return await this.loader.load(path);
  }

  /**
   * Load WDT data using the lite loader (more memory efficient)
   */
  static async loadDataLite(path) {
    return await this.loaderLite.load(path);
  }

  /**
   * Get the WDT loader instance
   */
  static getLoader() {
    return this.loader;
  }

  /**
   * Get the WDT lite loader instance
   */
  static getLoaderLite() {
    return this.loaderLite;
  }

}

export default WDT;
