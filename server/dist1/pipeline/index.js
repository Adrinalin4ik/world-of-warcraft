'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _arrayFind = require('array-find');

var _arrayFind2 = _interopRequireDefault(_arrayFind);

var _express = require('express');

var _express2 = _interopRequireDefault(_express);

var _pngjs = require('pngjs');

var _restructure = require('restructure');

var _blp = require('../wow-data-parser/blp');

var _blp2 = _interopRequireDefault(_blp);

var _entities = require('../wow-data-parser/dbc/entities');

var DBC = _interopRequireWildcard(_entities);

var _config = require('../config');

var _config2 = _interopRequireDefault(_config);

var _archive = require('./archive');

var _archive2 = _interopRequireDefault(_archive);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Pipeline {

  static get DATA_DIR() {
    return _config2.default.db.get('clientData');
  }

  constructor() {
    this.router = (0, _express2.default)();
    this.router.param('resource', this.resource.bind(this));
    this.router.get('/:resource(*.blp).png', this.blp.bind(this));
    this.router.get('/:resource(*.dbc)/:id(*)?.json', this.dbc.bind(this));
    this.router.get('/find/:query', this.find.bind(this));
    this.router.get('/:resource', this.serve.bind(this));
  }

  get archive() {
    this._archive = this._archive || _archive2.default.build(this.constructor.DATA_DIR);
    return this._archive;
  }

  resource(req, _res, next, path) {
    req.resourcePath = path;
    req.resource = this.archive.files.get(path);
    if (req.resource) {
      next();

      // Ensure file is closed in StormLib.
      req.resource.close();
    } else {
      var err = new Error('resource not found');
      err.status = 404;
      throw err;
    }
  }

  blp(req, res) {
    _blp2.default.from(req.resource.data, function (blp) {
      var mipmap = blp.largest;

      var png = new _pngjs.PNG({ width: mipmap.width, height: mipmap.height });
      png.data = mipmap.rgba;

      res.type('image/png');
      png.pack().pipe(res);
    });
  }

  dbc(req, res) {
    var name = req.resourcePath.match(/(\w+)\.dbc/)[1];
    var definition = DBC[name];
    if (definition) {
      var dbc = definition.dbc.decode(new _restructure.DecodeStream(req.resource.data));
      var id = req.params.id;
      if (id) {
        var match = (0, _arrayFind2.default)(dbc.records, function (entity) {
          return String(entity.id) === id;
        });
        if (match) {
          res.send(match);
        } else {
          var err = new Error('entity not found');
          err.status = 404;
          throw err;
        }
      } else {
        res.send(dbc.records);
      }
    } else {
      var _err = new Error('entity definition not found');
      _err.status = 404;
      throw _err;
    }
  }

  find(req, res) {
    var results = this.archive.files.find(req.params.query).map(result => {
      var path = `${req.baseUrl}/${encodeURI(result.filename)}`;
      var link = `${req.protocol}://${req.headers.host}${path}`;
      return {
        filename: result.filename,
        name: result.name,
        size: result.fileSize,
        link: link
      };
    });
    res.send(results);
  }

  serve(req, res) {
    res.type(req.resource.name);
    res.send(req.resource.data);
  }

}

exports.default = Pipeline;
module.exports = exports['default'];