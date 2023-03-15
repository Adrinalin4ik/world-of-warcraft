"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _localizedStringRef = _interopRequireDefault(require("../localized-string-ref"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  achievementID: _restructure["default"].uint32le,
  type: _restructure["default"].uint32le,
  assetID: _restructure["default"].uint32le,
  quantity: _restructure["default"].uint32le,
  startEvent: _restructure["default"].uint32le,
  startAsset: _restructure["default"].uint32le,
  failEvent: _restructure["default"].uint32le,
  failAsset: _restructure["default"].uint32le,
  description: _localizedStringRef["default"],
  flags: _restructure["default"].uint32le,
  timerStartEvent: _restructure["default"].uint32le,
  timerAssetID: _restructure["default"].uint32le,
  timerTime: _restructure["default"].uint32le,
  order: _restructure["default"].uint32le
});
exports["default"] = _default;