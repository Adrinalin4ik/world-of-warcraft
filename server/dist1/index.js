'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _express = require('express');

var _express2 = _interopRequireDefault(_express);

var _morgan = require('morgan');

var _morgan2 = _interopRequireDefault(_morgan);

var _pipeline = require('./pipeline');

var _pipeline2 = _interopRequireDefault(_pipeline);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Server {

  constructor(port) {
    var root = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : process.pwd;

    this.port = port;
    this.root = root;

    this.app = (0, _express2.default)();

    this.app.set('root', this.root);
    this.app.use((0, _morgan2.default)('dev'));
    this.app.use(_express2.default.static('./public'));
    this.app.use('/pipeline', new _pipeline2.default().router);
  }

  start() {
    this.app.listen(this.port);
  }

}

exports.default = Server;
module.exports = exports['default'];