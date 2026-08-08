"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _refNapi = _interopRequireDefault(require("ref-napi"));
var _file = _interopRequireDefault(require("./file"));
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
var Files = /*#__PURE__*/function () {
  function Files(mpq) {
    _classCallCheck(this, Files);
    this.mpq = mpq;
  }
  _createClass(Files, [{
    key: "handle",
    get: function get() {
      return this.mpq.handle;
    }
  }, {
    key: "contains",
    value: function contains(file) {
      return !!this.handle && _stormLib["default"].SFileHasFile(this.handle, file);
    }
  }, {
    key: "get",
    value: function get(file) {
      if (this.handle) {
        var fileHandlePtr = _refNapi["default"].alloc(_stormLib.HANDLEPtr);
        if (_stormLib["default"].SFileOpenFileEx(this.handle, file, this.constructor.FROM_MPQ, fileHandlePtr)) {
          return new _file["default"](fileHandlePtr.deref());
        }
      }
      return null;
    }
  }, {
    key: "extract",
    value: function extract(file, target) {
      if (!_stormLib["default"].SFileExtractFile(this.handle, file, target, this.constructor.FROM_MPQ)) {
        var errno = _stormLib["default"].GetLastError();
        throw new Error("file could not be extracted (".concat(errno, ")"));
      }
      return true;
    }
  }, {
    key: "all",
    get: function get() {
      return this.find('*');
    }
  }, {
    key: "find",
    value: function find(pattern) {
      var _this = this;
      var handle = null;
      var next = function next() {
        var data = new _stormLib.FIND_DATA();
        if (!handle) {
          handle = _stormLib["default"].SFileFindFirstFile(_this.handle, pattern, data.ref(), null);
          if (!handle.isNull()) {
            return data;
          }
        } else {
          if (_stormLib["default"].SFileFindNextFile(handle, data.ref())) {
            return data;
          }
        }
      };
      var results = [];
      var data;
      while (data = next()) {
        results.push(data);
      }
      _stormLib["default"].SFileFindClose(handle);
      return results;
    }
  }]);
  return Files;
}();
_defineProperty(Files, "FROM_MPQ", 0x00000000);
_defineProperty(Files, "FROM_LOCAL", 0xFFFFFFFF);
var _default = Files;
exports["default"] = _default;