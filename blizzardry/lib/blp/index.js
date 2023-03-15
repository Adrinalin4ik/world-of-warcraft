"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _crypto = _interopRequireDefault(require("crypto"));
var _fs = _interopRequireDefault(require("fs"));
var _temp = _interopRequireDefault(require("temp"));
var _cLib = _interopRequireDefault(require("../c-lib"));
var _blpLib = _interopRequireDefault(require("./blp-lib"));
var _mipmap = _interopRequireDefault(require("./mipmap"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _defineProperty(obj, key, value) { key = _toPropertyKey(key); if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return _typeof(key) === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (_typeof(input) !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (_typeof(res) !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
var BLP = /*#__PURE__*/function () {
  function BLP(path, handle, file) {
    _classCallCheck(this, BLP);
    this.path = path;
    this.handle = handle;
    this.file = file;
    this.mipmaps = [];
    for (var i = 0; i < this.mipmapCount; ++i) {
      this.mipmaps.push(new _mipmap["default"](this, i));
    }
  }
  _createClass(BLP, [{
    key: "close",
    value: function close() {
      var handle = this.handle;
      if (handle) {
        this.handle = null;
        _blpLib["default"].blp_release(handle);
      }
      var file = this.file;
      if (file) {
        this.file = null;
        _cLib["default"].fclose(file);
        if (this.path.match(this.constructor.TMP_PREFIX)) {
          _fs["default"].unlinkSync(this.path);
        }
      }
    }
  }, {
    key: "opened",
    get: function get() {
      return !!this.file;
    }
  }, {
    key: "version",
    get: function get() {
      return _blpLib["default"].blp_version(this.handle);
    }
  }, {
    key: "mipmapCount",
    get: function get() {
      return _blpLib["default"].blp_nbMipLevels(this.handle);
    }
  }, {
    key: "smallest",
    get: function get() {
      return this.mipmaps[this.mipmapCount - 1];
    }
  }, {
    key: "largest",
    get: function get() {
      return this.mipmaps[0];
    }
  }], [{
    key: "open",
    value: function open(path, callback) {
      var file = _cLib["default"].fopen(path, 'r');
      if (!file.isNull()) {
        var handle = _blpLib["default"].blp_processFile(file);
        if (!handle.isNull()) {
          var blp = new this(path, handle, file);
          if (callback) {
            callback(blp);
            blp.close();
            return true;
          }
          return blp;
        }
        _cLib["default"].fclose(file);
        throw new Error('image could not be opened');
      }
      throw new Error('image could not be found');
    }
  }, {
    key: "from",
    value: function from(buffer, callback) {
      var tmp = _temp["default"].path({
        prefix: this.TMP_PREFIX
      });
      _fs["default"].writeFileSync(tmp, buffer);
      try {
        return this.open(tmp, callback);
      } catch (e) {
        _fs["default"].unlinkSync(tmp);
        throw e;
      }
    }
  }]);
  return BLP;
}();
_defineProperty(BLP, "TMP_PREFIX", "blp-".concat(_crypto["default"].randomBytes(6).toString('hex'), "-"));
var _default = BLP;
exports["default"] = _default;