"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _blpLib = _interopRequireDefault(require("./blp-lib"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return _typeof(key) === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (_typeof(input) !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (_typeof(res) !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
var Mipmap = /*#__PURE__*/function () {
  function Mipmap(blp, level) {
    _classCallCheck(this, Mipmap);
    this.blp = blp;
    this.level = level;
  }
  _createClass(Mipmap, [{
    key: "width",
    get: function get() {
      return _blpLib["default"].blp_width(this.blp.handle, this.level);
    }
  }, {
    key: "height",
    get: function get() {
      return _blpLib["default"].blp_height(this.blp.handle, this.level);
    }
  }, {
    key: "data",
    get: function get() {
      var data = _blpLib["default"].blp_convert(this.blp.file, this.blp.handle, this.level);
      var size = this.width * this.height * 4;
      return data.reinterpret(size, 0);
    }
  }, {
    key: "bgra",
    get: function get() {
      return this.data;
    }
  }, {
    key: "rgba",
    get: function get() {
      var pixels = this.data;
      var length = pixels.length;
      for (var i = 0; i < length; i += 4) {
        var blue = pixels[i];
        var red = pixels[i + 2];
        pixels[i] = red;
        pixels[i + 2] = blue;
      }
      return pixels;
    }
  }]);
  return Mipmap;
}();
var _default = Mipmap;
exports["default"] = _default;
//# sourceMappingURL=mipmap.js.map