import Task from './task';
import Thread from './thread';

class WorkerPool {

  constructor(concurrency = this.defaultConcurrency) {
    this.concurrency = concurrency;
    this.queue = [];
    this.threads = [];

    this.next = this.next.bind(this);
  }

  get defaultConcurrency() {
    return navigator.hardwareConcurrency || 4;
  }

  get thread() {
    let thread = this.threads.find(current => current.idle);
    if (thread) {
      return thread;
    }

    if (this.threads.length < this.concurrency) {
      thread = new Thread();
      this.threads.push(thread);
      return thread;
    }
  }

  enqueue(...args) {
    const task = new Task(...args);
    this.queue.push(task);
    this.next();
    return task.promise;
  }

  next() {
    try {

      if (this.queue.length) {
        const thread = this.thread;
        if (thread) {
          const task = this.queue.shift();
          return thread.execute(task).then((_res) => {
            return this.next()
          }).catch( (ex) => {
            console.error(ex)
            return this.next()
          });
        }
      }
    } catch (ex) {
      console.error(ex)
    }
  }

}

export { WorkerPool };
export default new WorkerPool();
