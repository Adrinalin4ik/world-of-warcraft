"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;
var _restructure = _interopRequireDefault(require("restructure"));
var _entity = _interopRequireDefault(require("../entity"));
var _stringRef = _interopRequireDefault(require("../string-ref"));
var _types = require("../../types");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }
var _default = (0, _entity["default"])({
  id: _restructure["default"].uint32le,
  name: _stringRef["default"],
  effectGroupID: _restructure["default"].uint32le,
  triggerType: _restructure["default"].uint32le,
  eventType: _restructure["default"].uint32le,
  effectRecType: _restructure["default"].uint32le,
  effectRecID: _restructure["default"].uint32le,
  attachment: _restructure["default"].uint32le,
  offset: _types.Vec3Float,
  effectModifierID: _restructure["default"].uint32le
});
exports["default"] = _default;