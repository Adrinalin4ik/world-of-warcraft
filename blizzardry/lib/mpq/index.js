"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _refNapi = _interopRequireDefault(require("ref-napi"));
var _files = _interopRequireDefault(require("./files"));
var _stormLib = _interopRequireWildcard(require("./storm-lib"));
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _defineProperty(obj, key, value) { key = _toPropertyKey(key); if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return _typeof(key) === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (_typeof(input) !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (_typeof(res) !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
var MPQ = /*#__PURE__*/function () {
  function MPQ(path, flags, handle) {
    _classCallCheck(this, MPQ);
    this.path = path;
    this.flags = flags;
    this.handle = handle;
    this.files = new _files["default"](this);
  }
  _createClass(MPQ, [{
    key: "close",
    value: function close() {
      var handle = this.handle;
      if (handle) {
        this.handle = null;
        return _stormLib["default"].SFileCloseArchive(handle);
      }
    }
  }, {
    key: "opened",
    get: function get() {
      return !!this.handle;
    }
  }, {
    key: "patch",
    value: function patch(path) {
      var prefix = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
      if (!(this.flags & this.constructor.OPEN.READ_ONLY)) {
        throw new Error('archive must be read-only');
      }
      var flags = 0;
      return _stormLib["default"].SFileOpenPatchArchive(this.handle, path, prefix, flags);
    }
  }, {
    key: "patched",
    get: function get() {
      if (this.handle) {
        return _stormLib["default"].SFileIsPatchedArchive(this.handle);
      }
    }
  }], [{
    key: "locale",
    get: function get() {
      return _stormLib["default"].SFileGetLocale();
    },
    set: function set(locale) {
      _stormLib["default"].SFileSetLocale(locale);
    }
  }, {
    key: "open",
    value: function open(path) {
      var flags = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
      var callback = arguments.length > 2 ? arguments[2] : undefined;
      if (typeof flags === 'function' && callback === undefined) {
        return this.open(path, null, flags);
      }
      var priority = 0;
      var handlePtr = _refNapi["default"].alloc(_stormLib.HANDLEPtr);
      if (_stormLib["default"].SFileOpenArchive(path, priority, flags, handlePtr)) {
        var handle = handlePtr.deref();
        var mpq = new this(path, flags, handle);
        if (callback !== undefined) {
          callback(mpq);
          // mpq.close();
          return true;
        }
        return mpq;
      }
      var errno = _stormLib["default"].GetLastError();
      throw new Error("archive could not be found or opened (".concat(errno, ")"));
    }
  }, {
    key: "create",
    value: function create(path, callback) {
      var flags = 0;
      var maxFileCount = 0;
      var handlePtr = _refNapi["default"].alloc(_stormLib.HANDLEPtr);
      if (_stormLib["default"].SFileCreateArchive(path, flags, maxFileCount, handlePtr)) {
        return this.open(path, callback);
      }
      var errno = _stormLib["default"].GetLastError();
      throw new Error("archive could not be created (".concat(errno, ")"));
    }
  }]);
  return MPQ;
}();
_defineProperty(MPQ, "OPEN", {
  READ_ONLY: 0x00000100,
  WRITE_SHARE: 0x00000200,
  USE_BITMAP: 0x00000400,
  NO_LISTFILE: 0x00010000,
  NO_ATTRIBUTES: 0x00020000,
  NO_HEADER_SEARCH: 0x00040000,
  FORCE_MPQ_V1: 0x00080000,
  CHECK_SECTOR_CRC: 0x00100000
});
_defineProperty(MPQ, "CREATE", {
  LISTFILE: 0x00100000,
  ATTRIBUTES: 0x00200000,
  SIGNATURE: 0x00400000,
  ARCHIVE_V1: 0x00000000,
  ARCHIVE_V2: 0x01000000,
  ARCHIVE_V3: 0x02000000,
  ARCHIVE_V4: 0x03000000
});
var _default = MPQ;
exports["default"] = _default;