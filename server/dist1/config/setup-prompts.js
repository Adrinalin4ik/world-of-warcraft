'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _os = require('os');

var _os2 = _interopRequireDefault(_os);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = [{
  type: 'input',
  name: 'clientData',
  message: 'Client data directory',
  default: function () {
    if (process.platform === 'win32') {
      return 'C:/Program Files (x86)/World of Warcraft/Data';
    }
    return '/Applications/World of Warcraft/Data';
  },
  validate: function (value) {
    var done = this.async();

    _fs2.default.lstat(value, function (err, stats) {
      if (err) {
        done('Invalid path');
      } else if (stats.isDirectory()) {
        done(true);
      } else {
        done('Please provide path to a directory');
      }
    });
  }
}, {
  type: 'input',
  name: 'serverPort',
  message: 'Server port',
  default: '3000'
}, {
  type: 'input',
  name: 'clusterWorkerCount',
  message: 'Number of cluster workers',
  default: Math.ceil(_os2.default.cpus().length / 2)
}];
module.exports = exports['default'];