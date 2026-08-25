import Task from './task';
import Thread from './thread';

/**
 * The asset fetch/decode pool: one bounded set of workers, and ONE queue in front of them.
 *
 * The queue is the whole story of this class. Everything the client streams goes through it -- ADT
 * terrain, WDT, DBCs, M2 models, WMO roots and groups, and every BLP texture -- and until this
 * round it was a plain FIFO array. That is fine when the arrival rate is below the drain rate and
 * catastrophic when it is not, which is exactly what entering a populated zone does: the terrain
 * stream enqueues hundreds of tasks in a burst, and anything a PLAYER asked for afterwards waits
 * behind all of them. Measured on a real entry at Northshire, the local player's own textures took
 * 244 ms and two peers' took 6.8 s and 8.4 s -- a player standing untextured for eight seconds while
 * the pool worked through terrain tiles for a hillside behind him.
 *
 * That is a scheduling defect, not a throughput one. The same bytes are fetched and the same
 * decodes run either way; only the ORDER changes. So the fix is a priority, and it is exact in the
 * sense this project uses the word: nothing is dropped, deferred forever, or approximated.
 *
 * See `PRIORITY` below for the classes and `stats` for the instrument that established the numbers.
 */

/**
 * Scheduling classes. Higher runs first; ties keep arrival order (the sort is stable, and `insert`
 * below scans from the tail, so equal priorities stay FIFO among themselves).
 *
 * Only two levels, deliberately. A finer ladder needs evidence to place its rungs, and the measured
 * distribution has exactly one bimodal split in it: things a visible character needs NOW, and the
 * background terrain stream. Adding a third class without a measurement to justify it is how a
 * scheduler acquires rules nobody can later defend.
 */
export const PRIORITY = {
  /** The background stream: terrain, buildings, the map's own doodads. */
  BACKGROUND: 0,
  /**
   * Something a visible character is missing. A unit standing in the world with a placeholder
   * texture is a visible defect on every frame it persists; a terrain tile arriving 200 ms later is
   * a tile that fades in 200 ms later, at the edge of the draw distance, where nothing looks at it.
   */
  CHARACTER: 1,
};

class WorkerPool {

  constructor(concurrency = this.defaultConcurrency) {
    this.concurrency = concurrency;
    this.queue = [];
    this.threads = [];
    this.next = this.next.bind(this);

    /**
     * The instrument. Written on every task, read by the probe through `window.workerPool`.
     *
     * WHY IT IS PERMANENT AND UNGATED. Two of this project's debug instruments read zero while the
     * world was fine, because they were only written from inside a rebuild that a disabled checkbox
     * skipped -- and one of those produced a wrong diagnosis. An instrument that has to be switched
     * on is an instrument that reads zero exactly when someone needs it. The cost here is one
     * `performance.now()` and a handful of adds per TASK (not per frame), against a task whose own
     * body is a network fetch and a BLP decode.
     *
     * `waitMs` is the number that matters: queued -> started, i.e. head-of-line blocking. `runMs` is
     * the work itself and priority cannot change it.
     */
    this.stats = {
      enqueued: 0,
      completed: 0,
      /** Longest queue the pool has ever held. The burst size, in one number. */
      peakDepth: 0,
      byPriority: {},
    };
  }

  get defaultConcurrency() {
    // `navigator` is undefined under a plain Node test environment (e.g. Jest's
    // `@jest-environment node`), which previously made importing anything upstream of
    // TextureLoader throw before a single test could run.
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
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

  /** Background priority. The 6 streaming call sites keep calling this and are unchanged. */
  enqueue(...args) {
    return this.enqueueAt(PRIORITY.BACKGROUND, ...args);
  }

  /**
   * Enqueue at an explicit priority.
   *
   * A SEPARATE METHOD rather than an extra argument on `enqueue`, because `enqueue`'s arguments are
   * the worker's own message payload (`[loader, ...loaderArgs]`, see `worker/index.js`) and a
   * trailing option would be indistinguishable from a loader argument -- `BLP` already takes a
   * second one. Prefixing is unambiguous.
   *
   * And NOT a path-sniffing classifier inside the pool, which was the other candidate: `BLP` is the
   * loader for a terrain tileset and for a character's face alike, so the pool cannot tell them
   * apart from what it is given. Only the caller knows why it is asking. Keeping the decision at the
   * call site also means a new caller gets background by default, which is the safe direction.
   */
  enqueueAt(priority, ...args) {
    return this.submit(priority, false, args);
  }

  /**
   * As `enqueueAt`, but a FAILURE IS EXPECTED and is not logged.
   *
   * Some loads are speculative by design. A character's armour layer is named per gender and the
   * gendered file frequently does not exist, so `ui/scene/body-composite.ts` asks for it and falls
   * through to the `_U` variant -- its own comment calls the 404 "the NORMAL path to the `_U`
   * file". The pool logged it anyway, twice per miss (once here, once in `next`), and the owner saw a
   * console full of stack traces for a path that was working exactly as written.
   *
   * A separate METHOD for the reason the comment on `enqueueAt` gives for itself: the arguments are
   * the worker's own payload and a trailing option would be indistinguishable from a loader
   * argument. Quiet is a property of the REQUEST, not of the payload.
   *
   * It silences only the log. The rejection still settles the task the same way, so a caller that
   * wants to know still learns -- and a caller that has no fallback should keep using `enqueueAt`,
   * because a silent miss with nothing to fall back on is the invisible failure this project keeps
   * paying for.
   */
  enqueueQuietAt(priority, ...args) {
    return this.submit(priority, true, args);
  }

  /**
   * The one enqueue path. `quiet` decides only whether a failure reaches the console.
   *
   * Both catch sites read `task.quiet`: this one, and the one in `next` -- which is why a miss used
   * to log TWICE. Two logs for one failure read as two failures, and that is how the owner reported
   * it.
   */
  submit(priority, quiet, args) {
    const task = new Task(...args);
    task.quiet = quiet;
    task.priority = priority;
    task.queuedAt = now();

    this.insert(task);

    ++this.stats.enqueued;
    if (this.queue.length > this.stats.peakDepth) {
      this.stats.peakDepth = this.queue.length;
    }

    this.next();
    return task.promise.catch((ex) => {
      if (!task.quiet) {
        console.error(ex);
      }
    });
  }

  /**
   * Place `task` after every queued task of equal or higher priority.
   *
   * A linear scan FROM THE TAIL, not a sort and not a heap. The common case -- a background task
   * arriving behind a queue of background tasks -- exits on the first comparison, so the steady
   * state is O(1); the worst case is a character task jumping a full background burst, which is
   * O(depth) on a queue whose peak this instrument reports (see `stats.peakDepth`). A binary heap
   * would make that worst case O(log n) and would also lose FIFO order within a priority class,
   * which is the property that keeps a zone streaming in roughly the order it was asked for.
   */
  insert(task) {
    const queue = this.queue;

    // THE A/B SWITCH, and the reason it is a runtime flag rather than a rebuild.
    //
    // The before/after for this change has to be taken on the same build, the same spot and the
    // same backend, and the arms differ only in ORDER -- so anything that forces a rebuild between
    // them (editing a constant, checking out a parent commit) adds a recompiled bundle and a fresh
    // webpack chunk layout to a comparison that is supposed to isolate one variable. Setting this
    // before entering the world gives a true FIFO arm from the identical bundle.
    //
    // It is left in because the measurement has to stay reproducible: the gate on this round is a
    // before/after table with a stated noise floor, and a table nobody else can re-take is not
    // evidence. `priority` is still RECORDED on the task in both arms, so `stats.byPriority` keeps
    // reporting the character bucket's waits under FIFO -- which is the number the before arm
    // exists to produce, and which a neutralised PRIORITY constant would have merged away.
    if (typeof window === 'undefined' || !window.__poolFifo) {
      let i = queue.length;
      while (i > 0 && queue[i - 1].priority < task.priority) {
        --i;
      }
      queue.splice(i, 0, task);
      return;
    }

    queue.push(task);
  }

  next() {
    try {
      if (this.queue.length) {
        const thread = this.thread;
        if (thread) {
          const task = this.queue.shift();
          const startedAt = now();
          return thread.execute(task).then((_res) => {
            this.record(task, startedAt);
            return this.next()
          }).catch( (ex) => {
            this.record(task, startedAt);
            // See `submit`: a speculative load logs nothing. The task still settles as a failure.
            if (!task.quiet) {
              console.error(ex)
            }
            return this.next()
          });
        }
      }
    } catch (ex) {
      console.error(ex)
    }
  }

  /** One completed task, success or failure. A failed fetch still queued and still waited. */
  record(task, startedAt) {
    const bucket = this.bucket(task.priority);
    ++bucket.count;
    const waitMs = startedAt - task.queuedAt;
    bucket.waitTotalMs += waitMs;
    if (waitMs > bucket.waitMaxMs) {
      bucket.waitMaxMs = waitMs;
      bucket.waitMaxArgs = String(task.args && task.args[1]);
    }
    bucket.runTotalMs += now() - startedAt;
    ++this.stats.completed;
  }

  bucket(priority) {
    let bucket = this.stats.byPriority[priority];
    if (!bucket) {
      bucket = this.stats.byPriority[priority] = {
        count: 0, waitTotalMs: 0, waitMaxMs: 0, waitMaxArgs: null, runTotalMs: 0,
      };
    }
    return bucket;
  }

}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const pool = new WorkerPool();

// Reachable from a probe without importing the module graph. Same shape as `collisionWorld`,
// `moveTrace` and `modelProbe` already use.
if (typeof window !== 'undefined') {
  window.workerPool = pool;
}

export { WorkerPool };
export default pool;
