"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = _default;
var r = _interopRequireWildcard(require("restructure"));
var _nofs = _interopRequireDefault(require("./nofs"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
function _default(type) {
  return new r.Struct({
    interpolationType: r.uint16le,
    globalSequenceID: r.int16le,
    timestamps: new _nofs["default"](new _nofs["default"](r.uint32le)),
    values: new _nofs["default"](new _nofs["default"](type)),
    trackCount: function trackCount() {
      return this.values.length;
    },
    tracks: function tracks() {
      var tracks = [];
      for (var trackIndex = 0; trackIndex < this.trackCount; trackIndex++) {
        var track = {};

        // Corresponds to offset in animations array of MD2.
        track.animationIndex = trackIndex;
        track.timestamps = this.timestamps[trackIndex] || [];
        track.values = this.values[trackIndex] || [];
        tracks.push(track);
      }
      return tracks;
    },
    maxTrackLength: function maxTrackLength() {
      var max = 0;
      this.tracks.forEach(function (track) {
        if (track.timestamps.length > max) {
          max = track.timestamps.length;
        }
      });
      return max;
    },
    keyframeCount: function keyframeCount() {
      var keyframeCount = 0;
      for (var i = 0, len = this.tracks.length; i < len; ++i) {
        keyframeCount += this.tracks[i].timestamps.length;
      }
      return keyframeCount;
    },
    firstKeyframe: function firstKeyframe() {
      if (this.tracks.length === 0) {
        return null;
      } else {
        for (var i = 0, len = this.tracks.length; i < len; ++i) {
          var track = this.tracks[i];
          if (track.timestamps.length > 0) {
            return {
              timestamp: track.timestamps[0],
              value: track.values[0]
            };
          }
        }
        return null;
      }
    },
    empty: function empty() {
      return this.maxTrackLength === 0;
    },
    animated: function animated() {
      return !this.empty;
    }
  });
}
//# sourceMappingURL=animation-block.js.map