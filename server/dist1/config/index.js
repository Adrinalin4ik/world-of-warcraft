'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _configstore = require('configstore');

var _configstore2 = _interopRequireDefault(_configstore);

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

var _inquirer = require('inquirer');

var _inquirer2 = _interopRequireDefault(_inquirer);

var _package = require('../../package.json');

var _package2 = _interopRequireDefault(_package);

var _setupPrompts = require('./setup-prompts');

var _setupPrompts2 = _interopRequireDefault(_setupPrompts);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class ServerConfig {

  constructor() {
    var defaults = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.constructor.DEFAULTS;

    this.db = new _configstore2.default(_package2.default.name, defaults);
  }

  get isFirstRun() {
    return this.db.get('isFirstRun');
  }

  verify() {
    var promise = this.isFirstRun ? this.prompt() : _bluebird2.default.resolve();
    return promise.then(function () {
      // TODO: Verify the actual configuration and bail out when needed
    });
  }

  prompt() {
    return new _bluebird2.default((resolve, _reject) => {
      console.log('> Preparing initial setup\n');

      _inquirer2.default.prompt(_setupPrompts2.default, answers => {
        Object.keys(answers).map(key => {
          return this.db.set(key, answers[key]);
        });

        this.db.set('isFirstRun', false);

        console.log('\n> Setup finished!');
        resolve();
      });
    });
  }
}

ServerConfig.DEFAULTS = {
  'clientData': null,
  'clusterWorkerCount': 1,
  'isFirstRun': true,
  'serverPort': '3000'
};
exports.default = new ServerConfig();
module.exports = exports['default'];