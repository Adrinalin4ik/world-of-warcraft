import ADT from '../adt/loader';
import BLP from '../blp/loader';
import DBC from '../dbc/loader';
import M2 from '../m2/loader';
import WDT from '../wdt/loader';
import WMORoot from '../wmo/root/loader/worker';
import WMOGroup from '../wmo/group/loader/worker';

// eslint-disable-next-line no-restricted-globals
const worker = self;

const loaders = {
  ADT,
  BLP,
  DBC,
  M2,
  WDT,
  WMORoot,
  WMOGroup
};

const fulfill = function(success, value) {
  const result = {
    success: success,
    value: value
  };

  const transferable = value.transferable || [];

  worker.postMessage(result, transferable);
};

const resolve = function(value) {
  fulfill(true, value);
};

// A STRUCTURE, not `error.toString()`. An Error does not survive `postMessage` (the structured clone
// keeps neither the prototype nor the stack usefully), so the old code flattened it to a bare string
// and `Thread#_onMessage` then rejected the task with that string. Bluebird reported the result as
// "a promise was rejected with a non-error: [object String]" and every asset failure -- 404s, undecodable
// BLPs -- arrived at its caller with no stack and no type, which is exactly why two of them went
// unnoticed for a session. `Thread` rebuilds a real Error from these three fields.
const reject = function(error) {
  fulfill(false, {
    __workerError: true,
    name: (error && error.name) || 'Error',
    message: (error && error.message) || String(error),
    stack: error && error.stack ? String(error.stack) : undefined,
  });
};

worker.addEventListener('message', (event) => {
  const [loader, ...args] = event.data;
  if (loader in loaders) {
    loaders[loader](...args).then(function(result) {
      resolve(result);
    }).catch((error) => {
      reject(error);
    });
  } else {
    reject(new Error(`Invalid loader: ${loader}`));
  }
});
