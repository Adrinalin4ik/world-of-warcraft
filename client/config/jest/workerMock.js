'use strict';

// `client/src/game/pipeline/worker/thread.js` imports its worker with webpack's inline loader syntax,
// `import Worker from 'worker-loader!./'`. Jest has no webpack loader pipeline, so that specifier is
// unresolvable and any test that transitively imports the asset pipeline dies with
// "Cannot find module 'worker-loader!./'".
//
// This stands in for the generated Worker class. It deliberately does nothing: a test that actually
// needs decoded game assets should drive the loaders directly rather than through a fake worker, and
// silently resolving work here would make such a test look like it passed.
class WorkerMock {
  addEventListener() {}

  removeEventListener() {}

  postMessage() {}

  terminate() {}
}

module.exports = WorkerMock;
module.exports.default = WorkerMock;
