"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _chunk = _interopRequireDefault(require("../chunked/chunk"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _defineProperty(obj, key, value) { key = _toPropertyKey(key); if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return _typeof(key) === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (_typeof(input) !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (_typeof(res) !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
var MCAL = /*#__PURE__*/function () {
  function MCAL() {
    _classCallCheck(this, MCAL);
    this.chunk = (0, _chunk["default"])();
  }
  _createClass(MCAL, [{
    key: "decode",
    value: function decode(stream, parent) {
      var _this = this;
      var data = this.chunk.decode(stream, parent);

      // Skip the fully opaque initial layer
      var layers = parent.MCLY.layers.slice(1);
      data.alphaMaps = layers.map(function (layer) {
        if (layer.compressed) {
          return _this.decodeCompressed(stream);
        }
        return _this.decodeUncompressed(stream, parent);
      });
      return data;
    }
  }, {
    key: "decodeCompressed",
    value: function decodeCompressed(stream) {
      var size = this.constructor.ALPHA_MAP_SIZE;
      var buffer = stream.buffer;
      var alpha = new Buffer(size);
      var writePos = 0;
      while (writePos < size) {
        var fill = buffer[stream.pos] & 0x80;
        var count = buffer[stream.pos] & 0x7F;
        stream.pos++;
        for (var i = 0; i < count; ++i) {
          if (writePos === size) {
            break;
          }
          alpha[writePos] = buffer[stream.pos];
          writePos++;
          if (!fill) {
            stream.pos++;
          }
        }
        if (fill) {
          stream.pos++;
        }
      }
      return alpha;
    }
  }, {
    key: "decodeUncompressed",
    value: function decodeUncompressed(stream, parent) {
      var size = this.constructor.ALPHA_MAP_SIZE;
      var wdtFlags = parent.parent.wdtFlags;
      if (wdtFlags & 0x4 || wdtFlags & 0x80) {
        return stream.readBuffer(size);
      }
      var halfSize = this.constructor.ALPHA_MAP_HALF_SIZE;
      var buffer = stream.readBuffer(halfSize);
      var alpha = new Buffer(size);
      var side = Math.sqrt(size);
      for (var i = 0; i < halfSize; ++i) {
        var value = buffer[i];
        var offset = i * 2;
        alpha[offset] = (value & 0x0F) * 17;
        alpha[offset + 1] = (value >> 4) * 17;

        // Correct broken alpha maps unless flagged as correct by chunk
        // See: http://www.pxr.dk/wowdev/wiki/index.php?title=ADT/v18#Uncompressed_.282048.29
        if (!(parent.flags & 0x200)) {
          if (offset > size - side) {
            alpha[offset] = alpha[offset - side];
            alpha[offset + 1] = alpha[offset + 1 - side];
          }
          if (offset % side === side - 2) {
            alpha[offset + 1] = alpha[offset];
          }
        }
      }
      return alpha;
    }
  }]);
  return MCAL;
}();
_defineProperty(MCAL, "ALPHA_MAP_SIZE", 4096);
_defineProperty(MCAL, "ALPHA_MAP_HALF_SIZE", 2048);
var _default = new MCAL();
exports["default"] = _default;
//# sourceMappingURL=mcal.js.map