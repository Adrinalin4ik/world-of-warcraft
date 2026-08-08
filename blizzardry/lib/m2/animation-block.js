"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = _default;
var _restructure = _interopRequireDefault(require("restructure"));
var _nofs = _interopRequireDefault(require("./nofs"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _default(type) {
  return new _restructure["default"].Struct({
    interpolationType: _restructure["default"].uint16le,
    globalSequenceID: _restructure["default"].int16le,
    timestamps: new _nofs["default"](new _nofs["default"](_restructure["default"].uint32le)),
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