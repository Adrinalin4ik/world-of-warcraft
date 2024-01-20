'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _blpLib = require('./blp-lib');

var _blpLib2 = _interopRequireDefault(_blpLib);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class Mipmap {

  constructor(blp, level) {
    this.blp = blp;
    this.level = level;
  }

  get width() {
    return _blpLib2.default.blp_width(this.blp.handle, this.level);
  }

  get height() {
    return _blpLib2.default.blp_height(this.blp.handle, this.level);
  }

  get data() {
    var data = _blpLib2.default.blp_convert(this.blp.file, this.blp.handle, this.level);
    var size = this.width * this.height * 4;
    return data.reinterpret(size, 0);
  }

  get bgra() {
    return this.data;
  }

  get rgba() {
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

}

exports.default = Mipmap;
module.exports = exports['default'];