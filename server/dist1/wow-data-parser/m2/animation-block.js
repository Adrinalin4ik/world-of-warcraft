'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

exports.default = function (type) {
  return new r.Struct({
    interpolationType: r.uint16le,
    globalSequenceID: r.int16le,
    timestamps: new _nofs2.default(new _nofs2.default(r.uint32le)),
    values: new _nofs2.default(new _nofs2.default(type)),

    trackCount: function () {
      return this.values.length;
    },

    tracks: function () {
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

    maxTrackLength: function () {
      var max = 0;

      this.tracks.forEach(track => {
        if (track.timestamps.length > max) {
          max = track.timestamps.length;
        }
      });

      return max;
    },

    keyframeCount: function () {
      var keyframeCount = 0;

      for (var i = 0, len = this.tracks.length; i < len; ++i) {
        keyframeCount += this.tracks[i].timestamps.length;
      }

      return keyframeCount;
    },

    firstKeyframe: function () {
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

    empty: function () {
      return this.maxTrackLength === 0;
    },

    animated: function () {
      return !this.empty;
    }
  });
};

var _restructure = require('restructure');

var r = _interopRequireWildcard(_restructure);

var _nofs = require('./nofs');

var _nofs2 = _interopRequireDefault(_nofs);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

module.exports = exports['default'];