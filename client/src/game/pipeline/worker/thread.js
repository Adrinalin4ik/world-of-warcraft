// eslint-disable-next-line import/no-webpack-loader-syntax
import Worker from 'worker-loader!./';
class Thread {

  constructor() {
    this._onMessage = this._onMessage.bind(this);

    // this.worker = new Worker('worker.js');
    this.worker = new Worker();
    this.worker.addEventListener('message', this._onMessage);
  }

  get busy() {
    return !!this.task;
  }

  get idle() {
    return !this.busy;
  }

  execute(task) {
    this.task = task;
    this.worker.postMessage(task.args);
    return this.task.promise;
  }

  _onMessage(event) {
    const result = event.data;

    if (result.success) {
      this.task.resolve(result.value);
    } else {
      // Rebuild a real Error from the structure `worker/index.js#reject` sends. Rejecting with the
      // raw payload is what made every worker failure surface as "a promise was rejected with a
      // non-error" with no stack -- see that function for the whole of it. The fallback covers a
      // worker that predates the structure (or a browser that dropped a field): still an Error.
      const payload = result.value;
      const error = new Error(
        payload && payload.message ? payload.message : String(payload),
      );
      if (payload && payload.name) {
        error.name = payload.name;
      }
      if (payload && payload.stack) {
        // The worker's own stack, kept: it names the loader that actually failed, which this thread
        // cannot.
        error.workerStack = payload.stack;
      }
      this.task.reject(error);
    }

    this.task = null;
  }

}

export default Thread;
