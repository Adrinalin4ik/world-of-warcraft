"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var r = _interopRequireWildcard(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _stringRef = _interopRequireDefault(require("../string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
var _default = (0, _entity["default"])({
  id: r.uint32le,
  leftModelFile: _stringRef["default"],
  rightModelFile: _stringRef["default"],
  leftModelTexture: _stringRef["default"],
  rightModelTexture: _stringRef["default"],
  icon: _stringRef["default"],
  iconAlt: _stringRef["default"],
  geosetGroupIDs: new r.Array(r.uint32le, 3),
  flags: r.uint32le,
  spellVisualID: r.uint32le,
  groupSoundID: r.uint32le,
  maleHelmetGeosetVisID: r.uint32le,
  femaleHelmetGeosetVisID: r.uint32le,
  upperArmTexture: _stringRef["default"],
  lowerArmTexture: _stringRef["default"],
  handsTexture: _stringRef["default"],
  upperTorsoTexture: _stringRef["default"],
  lowerTorsoTexture: _stringRef["default"],
  upperLegTexture: _stringRef["default"],
  lowerLegTexture: _stringRef["default"],
  footTexture: _stringRef["default"],
  visualID: r.uint32le,
  particleColorID: r.uint32le
});
exports["default"] = _default;
//# sourceMappingURL=item-display-info.js.map