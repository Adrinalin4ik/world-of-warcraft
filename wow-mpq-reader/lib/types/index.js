"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.float32array4 = exports.float32array3 = exports.float32array2 = exports.fixed16array4 = exports.compfixed16array4 = exports.compfixed16 = exports.color16 = exports.Vec3Float = exports.Quat16Float = exports.Quat16 = exports.Quat = void 0;
var _color = _interopRequireWildcard(require("./color16"));
exports.color16 = _color;
var _compfixed = _interopRequireWildcard(require("./comp-fixed16"));
exports.compfixed16 = _compfixed;
var _compfixed16array = _interopRequireWildcard(require("./comp-fixed16-array4"));
exports.compfixed16array4 = _compfixed16array;
var _fixed16array = _interopRequireWildcard(require("./fixed16-array4"));
exports.fixed16array4 = _fixed16array;
var _float32array = _interopRequireWildcard(require("./float32-array2"));
exports.float32array2 = _float32array;
var _float32array2 = _interopRequireWildcard(require("./float32-array3"));
exports.float32array3 = _float32array2;
var _float32array3 = _interopRequireWildcard(require("./float32-array4"));
exports.float32array4 = _float32array3;
var _Quat = _interopRequireWildcard(require("./quat"));
exports.Quat = _Quat;
var _Quat2 = _interopRequireWildcard(require("./quat16"));
exports.Quat16 = _Quat2;
var _Quat16Float = _interopRequireWildcard(require("./quat16-float"));
exports.Quat16Float = _Quat16Float;
var _Vec3Float = _interopRequireWildcard(require("./vec3-float"));
exports.Vec3Float = _Vec3Float;
function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function _getRequireWildcardCache(nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }
function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || _typeof(obj) !== "object" && typeof obj !== "function") { return { "default": obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj["default"] = obj; if (cache) { cache.set(obj, newObj); } return newObj; }
//# sourceMappingURL=index.js.map