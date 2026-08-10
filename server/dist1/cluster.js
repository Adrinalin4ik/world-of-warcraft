'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _cluster = require('cluster');

var _cluster2 = _interopRequireDefault(_cluster);

var _ = require('./');

var _2 = _interopRequireDefault(_);

var _config = require('./config');

var _config2 = _interopRequireDefault(_config);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Cluster {

  get clustered() {
    return this.workerCount > 1;
  }

  get workerCount() {
    return _config2.default.db.get('clusterWorkerCount');
  }

  get serverPort() {
    return _config2.default.db.get('serverPort');
  }

  start() {
    if (!this.clustered || _cluster2.default.isMaster) {
      console.log(`\n> Settings loaded from ${_config2.default.db.path}`);
      console.log("> Use 'npm run reset' to clear settings\n");

      console.log(`> Starting server at localhost:${this.serverPort}\n`);
    }

    if (this.clustered && _cluster2.default.isMaster) {
      for (var i = 0; i < this.workerCount; ++i) {
        _cluster2.default.fork();
      }
    } else {
      this.spawn();
    }
  }

  spawn() {
    if (this.clustered) {
      console.log(`> Spawning worker (#${_cluster2.default.worker.id})`);
    }

    new _2.default(this.serverPort).start();
  }

}

exports.default = Cluster;
module.exports = exports['default'];