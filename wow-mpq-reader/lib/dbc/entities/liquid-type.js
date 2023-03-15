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
  name: _stringRef["default"],
  flags: r.uint32le,
  type: r.uint32le,
  soundEntryID: r.uint32le,
  spellID: r.uint32le,
  maxDarkenDepth: r.floatle,
  fogDarkenIntensity: r.floatle,
  ambDarkenIntensity: r.floatle,
  dirDarkenIntensity: r.floatle,
  lightID: r.uint32le,
  particleScale: r.floatle,
  particleMovement: r.uint32le,
  particleTexSlots: r.uint32le,
  liquidMaterialID: r.uint32le,
  textures: new r.Array(_stringRef["default"], 6),
  colors: new r.Array(r.uint32le, 2),
  shaderFloatAttributes: new r.Array(r.floatle, 18),
  shaderIntAttributes: new r.Array(r.uint32le, 4)
});
exports["default"] = _default;
//# sourceMappingURL=liquid-type.js.map