'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _restructure = require('restructure');

var _restructure2 = _interopRequireDefault(_restructure);

var _entity = require('../entity');

var _entity2 = _interopRequireDefault(_entity);

var _localizedStringRef = require('../localized-string-ref');

var _localizedStringRef2 = _interopRequireDefault(_localizedStringRef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

exports.default = (0, _entity2.default)({
  id: _restructure2.default.uint32le,
  categoryID: _restructure2.default.uint32le,
  dispelID: _restructure2.default.uint32le,
  mechanicID: _restructure2.default.uint32le,

  attributes: new _restructure2.default.Array(_restructure2.default.uint32le, 8),

  stances: _restructure2.default.uint32le,
  unknown1: new _restructure2.default.Reserved(_restructure2.default.uint32le),
  stancesExcluded: _restructure2.default.uint32le,
  unknown2: new _restructure2.default.Reserved(_restructure2.default.uint32le),

  targets: _restructure2.default.uint32le,
  targetCreatureType: _restructure2.default.uint32le,

  requiresSpellFocus: new _restructure2.default.Boolean(_restructure2.default.uint32le),
  facingCasterFlags: _restructure2.default.uint32le,

  casterAuraState: _restructure2.default.uint32le,
  targetAuraState: _restructure2.default.uint32le,
  casterAuraStateExcluded: _restructure2.default.uint32le,
  targetAuraStateExcluded: _restructure2.default.uint32le,
  casterAuraSpellID: _restructure2.default.uint32le,
  targetAuraSpellID: _restructure2.default.uint32le,
  casterAuraSpellExcluded: _restructure2.default.uint32le,
  targetAuraSpellExcluded: _restructure2.default.uint32le,

  castingTimeID: _restructure2.default.uint32le,
  recoveryTime: _restructure2.default.uint32le,
  categoryRecoveryTime: _restructure2.default.uint32le,
  interruptFlags: _restructure2.default.uint32le,
  auraInterruptFlags: _restructure2.default.uint32le,
  channelInterruptFlags: _restructure2.default.uint32le,
  procFlags: _restructure2.default.uint32le,
  procChance: _restructure2.default.uint32le,
  procCharges: _restructure2.default.uint32le,
  maxLevel: _restructure2.default.uint32le,
  baseLevel: _restructure2.default.uint32le,
  spellLevel: _restructure2.default.uint32le,
  durationID: _restructure2.default.uint32le,
  powerType: _restructure2.default.uint32le,
  manaCost: _restructure2.default.uint32le,
  manaCostPerlevel: _restructure2.default.uint32le,
  manaPerSecond: _restructure2.default.uint32le,
  manaPerSecondPerLevel: _restructure2.default.uint32le,
  rangeID: _restructure2.default.uint32le,
  speed: _restructure2.default.floatle,
  modalNextSpell: _restructure2.default.uint32le,
  stackAmount: _restructure2.default.uint32le,

  totemIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 2),
  reagentIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 8),
  reagentCounts: new _restructure2.default.Array(_restructure2.default.uint32le, 8),

  equippedItemClassID: _restructure2.default.int32le,
  equippedItemSubClassMask: _restructure2.default.int32le,
  equippedItemInventoryTypeMask: _restructure2.default.int32le,

  effectIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectDieSides: new _restructure2.default.Array(_restructure2.default.int32le, 3),
  effectBaseDices: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectDicesPerLevel: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectRealPointsPerLevel: new _restructure2.default.Array(_restructure2.default.floatle, 3),
  effectBasePoints: new _restructure2.default.Array(_restructure2.default.int32le, 3),
  effectMechanicIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectImplicitTargets: new _restructure2.default.Array(_restructure2.default.uint32le, 6),
  effectRadiusIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectAurasIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectAmplitudes: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectProcValues: new _restructure2.default.Array(_restructure2.default.floatle, 3),
  effectChainTargets: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectItemTypes: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectMiscValues: new _restructure2.default.Array(_restructure2.default.int32le, 6),
  effectTriggerSpells: new _restructure2.default.Array(_restructure2.default.uint32le, 3),
  effectPointsPerComboPoint: new _restructure2.default.Array(_restructure2.default.floatle, 3),
  effectSpellClassMasks: new _restructure2.default.Array(_restructure2.default.uint32le, 9),

  visualIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 2),
  iconID: _restructure2.default.uint32le,
  activeIconID: _restructure2.default.uint32le,

  priority: _restructure2.default.uint32le,
  name: _localizedStringRef2.default,
  rank: _localizedStringRef2.default,
  description: _localizedStringRef2.default,
  toolTip: _localizedStringRef2.default,

  manaCostPercentage: _restructure2.default.uint32le,
  startRecoveryCategory: _restructure2.default.uint32le,
  startRecoveryTime: _restructure2.default.uint32le,
  maxTargetLevel: _restructure2.default.uint32le,
  familyName: _restructure2.default.uint32le,
  familyFlags: new _restructure2.default.Array(_restructure2.default.uint32le, 3),

  maxAffectedTargets: _restructure2.default.uint32le,
  damageClass: _restructure2.default.uint32le,
  preventionType: _restructure2.default.uint32le,
  stanceBarOrder: _restructure2.default.uint32le,
  damageMultiplier: new _restructure2.default.Array(_restructure2.default.floatle, 3),
  minFactionID: _restructure2.default.uint32le,
  minReputation: _restructure2.default.uint32le,
  requiredAuraVision: _restructure2.default.uint32le,
  totemCategoryIDs: new _restructure2.default.Array(_restructure2.default.uint32le, 2),
  areaGroupID: _restructure2.default.int32le,
  schoolMask: _restructure2.default.uint32le,
  runeCostID: _restructure2.default.uint32le,
  spellMissileID: _restructure2.default.uint32le,
  powerDisplayID: _restructure2.default.uint32le,
  effectBonusMultipliers: new _restructure2.default.Array(_restructure2.default.floatle, 3),

  unknown3: new _restructure2.default.Reserved(_restructure2.default.uint32le)
});
module.exports = exports['default'];