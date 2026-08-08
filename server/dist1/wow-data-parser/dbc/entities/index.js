'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ZoneMusic = exports.ZoneIntroMusicTable = exports.WowError_Strings = exports.WorldStateZoneSounds = exports.WorldStateUI = exports.WorldSafeLocs = exports.WorldMapTransforms = exports.WorldMapOverlay = exports.WorldMapContinent = exports.WorldMapArea = exports.WMOAreaTable = exports.Weather = exports.VocalUISounds = exports.VehicleUIIndicator = exports.VehicleUIIndSeat = exports.UISoundLookups = exports.TransportAnimation = exports.TotemCategory = exports.TerrainTypeSounds = exports.TerrainType = exports.TeamContributionPoints = exports.TaxiPathNode = exports.TaxiPath = exports.TaxiNodes = exports.TalentTab = exports.Talent = exports.StringLookups = exports.Stationery = exports.Startup_Strings = exports.StableSlotPrices = exports.SpellVisualPrecastTransitions = exports.SpellVisualKitModelAttach = exports.SpellVisualKitAreaModel = exports.SpellVisualEffectName = exports.SpellRuneCost = exports.SpellRange = exports.SpellRadius = exports.SpellMechanic = exports.SpellItemEnchantmentCondition = exports.SpellItemEnchantment = exports.SpellIcon = exports.SpellFocusObject = exports.SpellEffectCameraShakes = exports.SpellDuration = exports.SpellDispelType = exports.SpellDifficulty = exports.SpellDescriptionVariables = exports.SpellCategory = exports.SpellCastTimes = exports.Spell = exports.SpamMessages = exports.SoundFilterElem = exports.SoundFilter = exports.SoundEntries = exports.SoundEmitters = exports.SoundAmbience = exports.SkillTiers = exports.SkillRaceClassInfo = exports.SkillLineCategory = exports.SkillLineAbility = exports.SkillLine = exports.SkillCostsData = exports.ServerMessages = exports.ScreenEffect = exports.Resistances = exports.QuestSort = exports.QuestInfo = exports.PowerDisplay = exports.PetitionType = exports.PetPersonality = exports.PaperDollItemFrame = exports.PageTextMaterial = exports.Package = exports.OverrideSpellData = exports.ObjectEffectPackageElem = exports.ObjectEffectPackage = undefined;
exports.ObjectEffectGroup = exports.ObjectEffect = exports.NPCSounds = exports.NamesReserved = exports.NamesProfanity = exports.NameGen = exports.MovieVariation = exports.MovieFileData = exports.Movie = exports.Material = exports.MapDifficulty = exports.Map = exports.MailTemplate = exports.LockType = exports.Lock = exports.LoadingScreens = exports.LiquidType = exports.LiquidMaterial = exports.LightSkybox = exports.LightParams = exports.LightIntBand = exports.LightFloatBand = exports.Light = exports.Languages = exports.LanguageWords = exports.ItemVisuals = exports.ItemVisualEffects = exports.ItemSubClassMask = exports.ItemSubClass = exports.ItemSet = exports.ItemRandomSuffix = exports.ItemRandomProperties = exports.ItemPurchaseGroup = exports.ItemPetFood = exports.ItemExtendedCost = exports.ItemDisplayInfo = exports.ItemClass = exports.ItemBagFamily = exports.Item = exports.HolidayNames = exports.HolidayDescriptions = exports.GameTips = exports.GameObjectDisplayInfo = exports.GameObjectArtKit = exports.FootprintTextures = exports.FileData = exports.FactionTemplate = exports.FactionGroup = exports.Faction = exports.Exhaustion = exports.EnvironmentalDamage = exports.EmotesTextSound = exports.EmotesTextData = exports.EmotesText = exports.Emotes = exports.DungeonMapChunk = exports.DungeonMap = exports.DungeonEncounter = exports.DeclinedWordCases = exports.DeclinedWord = exports.DanceMoves = exports.CurrencyTypes = exports.CurrencyCategory = exports.CreatureType = exports.CreatureSpellData = exports.CreatureMovementInfo = exports.CreatureModelData = exports.CreatureFamily = exports.CreatureDisplayInfoExtra = exports.CreatureDisplayInfo = exports.CinematicSequences = exports.CinematicCamera = exports.ChrRaces = exports.ChrClasses = exports.ChatProfanity = exports.ChatChannels = exports.CharacterFacialHairStyles = exports.CharTitles = exports.CharStartOutfit = exports.CharSections = exports.CharHairGeosets = exports.CharBaseInfo = exports.Cfg_Configs = exports.Cfg_Categories = exports.CameraShakes = exports.BattlemasterList = exports.BarberShopStyle = exports.BannedAddOns = exports.BankBagSlotPrices = exports.AuctionHouse = exports.AttackAnimTypes = exports.AttackAnimKits = exports.AreaTrigger = exports.AreaTable = exports.AreaPOI = exports.AreaGroup = exports.AnimationData = exports.Achievement_Criteria = exports.Achievement_Category = exports.Achievement = undefined;

var _achievement = require('./achievement');

var _Achievement = _interopRequireWildcard(_achievement);

var _achievementCategory = require('./achievement-category');

var _Achievement_Category = _interopRequireWildcard(_achievementCategory);

var _achievementCriteria = require('./achievement-criteria');

var _Achievement_Criteria = _interopRequireWildcard(_achievementCriteria);

var _animationData = require('./animation-data');

var _AnimationData = _interopRequireWildcard(_animationData);

var _areaGroup = require('./area-group');

var _AreaGroup = _interopRequireWildcard(_areaGroup);

var _areaPoi = require('./area-poi');

var _AreaPOI = _interopRequireWildcard(_areaPoi);

var _areaTable = require('./area-table');

var _AreaTable = _interopRequireWildcard(_areaTable);

var _areaTrigger = require('./area-trigger');

var _AreaTrigger = _interopRequireWildcard(_areaTrigger);

var _attackAnimKits = require('./attack-anim-kits');

var _AttackAnimKits = _interopRequireWildcard(_attackAnimKits);

var _attackAnimTypes = require('./attack-anim-types');

var _AttackAnimTypes = _interopRequireWildcard(_attackAnimTypes);

var _auctionHouse = require('./auction-house');

var _AuctionHouse = _interopRequireWildcard(_auctionHouse);

var _bankBagSlotPrices = require('./bank-bag-slot-prices');

var _BankBagSlotPrices = _interopRequireWildcard(_bankBagSlotPrices);

var _bannedAddOns = require('./banned-add-ons');

var _BannedAddOns = _interopRequireWildcard(_bannedAddOns);

var _barberShopStyle = require('./barber-shop-style');

var _BarberShopStyle = _interopRequireWildcard(_barberShopStyle);

var _battlemasterList = require('./battlemaster-list');

var _BattlemasterList = _interopRequireWildcard(_battlemasterList);

var _cameraShakes = require('./camera-shakes');

var _CameraShakes = _interopRequireWildcard(_cameraShakes);

var _cfgCategories = require('./cfg-categories');

var _Cfg_Categories = _interopRequireWildcard(_cfgCategories);

var _cfgConfigs = require('./cfg-configs');

var _Cfg_Configs = _interopRequireWildcard(_cfgConfigs);

var _charBaseInfo = require('./char-base-info');

var _CharBaseInfo = _interopRequireWildcard(_charBaseInfo);

var _charHairGeosets = require('./char-hair-geosets');

var _CharHairGeosets = _interopRequireWildcard(_charHairGeosets);

var _charSections = require('./char-sections');

var _CharSections = _interopRequireWildcard(_charSections);

var _charStartOutfit = require('./char-start-outfit');

var _CharStartOutfit = _interopRequireWildcard(_charStartOutfit);

var _charTitles = require('./char-titles');

var _CharTitles = _interopRequireWildcard(_charTitles);

var _characterFacialHairStyles = require('./character-facial-hair-styles');

var _CharacterFacialHairStyles = _interopRequireWildcard(_characterFacialHairStyles);

var _chatChannels = require('./chat-channels');

var _ChatChannels = _interopRequireWildcard(_chatChannels);

var _chatProfanity = require('./chat-profanity');

var _ChatProfanity = _interopRequireWildcard(_chatProfanity);

var _chrClasses = require('./chr-classes');

var _ChrClasses = _interopRequireWildcard(_chrClasses);

var _chrRaces = require('./chr-races');

var _ChrRaces = _interopRequireWildcard(_chrRaces);

var _cinematicCamera = require('./cinematic-camera');

var _CinematicCamera = _interopRequireWildcard(_cinematicCamera);

var _cinematicSequences = require('./cinematic-sequences');

var _CinematicSequences = _interopRequireWildcard(_cinematicSequences);

var _creatureDisplayInfo = require('./creature-display-info');

var _CreatureDisplayInfo = _interopRequireWildcard(_creatureDisplayInfo);

var _creatureDisplayInfoExtra = require('./creature-display-info-extra');

var _CreatureDisplayInfoExtra = _interopRequireWildcard(_creatureDisplayInfoExtra);

var _creatureFamily = require('./creature-family');

var _CreatureFamily = _interopRequireWildcard(_creatureFamily);

var _creatureModelData = require('./creature-model-data');

var _CreatureModelData = _interopRequireWildcard(_creatureModelData);

var _creatureMovementInfo = require('./creature-movement-info');

var _CreatureMovementInfo = _interopRequireWildcard(_creatureMovementInfo);

var _creatureSpellData = require('./creature-spell-data');

var _CreatureSpellData = _interopRequireWildcard(_creatureSpellData);

var _creatureType = require('./creature-type');

var _CreatureType = _interopRequireWildcard(_creatureType);

var _currencyCategory = require('./currency-category');

var _CurrencyCategory = _interopRequireWildcard(_currencyCategory);

var _currencyTypes = require('./currency-types');

var _CurrencyTypes = _interopRequireWildcard(_currencyTypes);

var _danceMoves = require('./dance-moves');

var _DanceMoves = _interopRequireWildcard(_danceMoves);

var _declinedWord = require('./declined-word');

var _DeclinedWord = _interopRequireWildcard(_declinedWord);

var _declinedWordCases = require('./declined-word-cases');

var _DeclinedWordCases = _interopRequireWildcard(_declinedWordCases);

var _dungeonEncounter = require('./dungeon-encounter');

var _DungeonEncounter = _interopRequireWildcard(_dungeonEncounter);

var _dungeonMap = require('./dungeon-map');

var _DungeonMap = _interopRequireWildcard(_dungeonMap);

var _dungeonMapChunk = require('./dungeon-map-chunk');

var _DungeonMapChunk = _interopRequireWildcard(_dungeonMapChunk);

var _emotes = require('./emotes');

var _Emotes = _interopRequireWildcard(_emotes);

var _emotesText = require('./emotes-text');

var _EmotesText = _interopRequireWildcard(_emotesText);

var _emotesTextData = require('./emotes-text-data');

var _EmotesTextData = _interopRequireWildcard(_emotesTextData);

var _emotesTextSound = require('./emotes-text-sound');

var _EmotesTextSound = _interopRequireWildcard(_emotesTextSound);

var _environmentalDamage = require('./environmental-damage');

var _EnvironmentalDamage = _interopRequireWildcard(_environmentalDamage);

var _exhaustion = require('./exhaustion');

var _Exhaustion = _interopRequireWildcard(_exhaustion);

var _faction = require('./faction');

var _Faction = _interopRequireWildcard(_faction);

var _factionGroup = require('./faction-group');

var _FactionGroup = _interopRequireWildcard(_factionGroup);

var _factionTemplate = require('./faction-template');

var _FactionTemplate = _interopRequireWildcard(_factionTemplate);

var _fileData = require('./file-data');

var _FileData = _interopRequireWildcard(_fileData);

var _footprintTextures = require('./footprint-textures');

var _FootprintTextures = _interopRequireWildcard(_footprintTextures);

var _gameObjectArtKit = require('./game-object-art-kit');

var _GameObjectArtKit = _interopRequireWildcard(_gameObjectArtKit);

var _gameObjectDisplayInfo = require('./game-object-display-info');

var _GameObjectDisplayInfo = _interopRequireWildcard(_gameObjectDisplayInfo);

var _gameTips = require('./game-tips');

var _GameTips = _interopRequireWildcard(_gameTips);

var _holidayDescriptions = require('./holiday-descriptions');

var _HolidayDescriptions = _interopRequireWildcard(_holidayDescriptions);

var _holidayNames = require('./holiday-names');

var _HolidayNames = _interopRequireWildcard(_holidayNames);

var _item = require('./item');

var _Item = _interopRequireWildcard(_item);

var _itemBagFamily = require('./item-bag-family');

var _ItemBagFamily = _interopRequireWildcard(_itemBagFamily);

var _itemClass = require('./item-class');

var _ItemClass = _interopRequireWildcard(_itemClass);

var _itemDisplayInfo = require('./item-display-info');

var _ItemDisplayInfo = _interopRequireWildcard(_itemDisplayInfo);

var _itemExtendedCost = require('./item-extended-cost');

var _ItemExtendedCost = _interopRequireWildcard(_itemExtendedCost);

var _itemPetFood = require('./item-pet-food');

var _ItemPetFood = _interopRequireWildcard(_itemPetFood);

var _itemPurchaseGroup = require('./item-purchase-group');

var _ItemPurchaseGroup = _interopRequireWildcard(_itemPurchaseGroup);

var _itemRandomProperties = require('./item-random-properties');

var _ItemRandomProperties = _interopRequireWildcard(_itemRandomProperties);

var _itemRandomSuffix = require('./item-random-suffix');

var _ItemRandomSuffix = _interopRequireWildcard(_itemRandomSuffix);

var _itemSet = require('./item-set');

var _ItemSet = _interopRequireWildcard(_itemSet);

var _itemSubClass = require('./item-sub-class');

var _ItemSubClass = _interopRequireWildcard(_itemSubClass);

var _itemSubClassMask = require('./item-sub-class-mask');

var _ItemSubClassMask = _interopRequireWildcard(_itemSubClassMask);

var _itemVisualEffects = require('./item-visual-effects');

var _ItemVisualEffects = _interopRequireWildcard(_itemVisualEffects);

var _itemVisuals = require('./item-visuals');

var _ItemVisuals = _interopRequireWildcard(_itemVisuals);

var _languageWords = require('./language-words');

var _LanguageWords = _interopRequireWildcard(_languageWords);

var _languages = require('./languages');

var _Languages = _interopRequireWildcard(_languages);

var _light = require('./light');

var _Light = _interopRequireWildcard(_light);

var _lightFloatBand = require('./light-float-band');

var _LightFloatBand = _interopRequireWildcard(_lightFloatBand);

var _lightIntBand = require('./light-int-band');

var _LightIntBand = _interopRequireWildcard(_lightIntBand);

var _lightParams = require('./light-params');

var _LightParams = _interopRequireWildcard(_lightParams);

var _lightSkybox = require('./light-skybox');

var _LightSkybox = _interopRequireWildcard(_lightSkybox);

var _liquidMaterial = require('./liquid-material');

var _LiquidMaterial = _interopRequireWildcard(_liquidMaterial);

var _liquidType = require('./liquid-type');

var _LiquidType = _interopRequireWildcard(_liquidType);

var _loadingScreens = require('./loading-screens');

var _LoadingScreens = _interopRequireWildcard(_loadingScreens);

var _lock = require('./lock');

var _Lock = _interopRequireWildcard(_lock);

var _lockType = require('./lock-type');

var _LockType = _interopRequireWildcard(_lockType);

var _mailTemplate = require('./mail-template');

var _MailTemplate = _interopRequireWildcard(_mailTemplate);

var _map = require('./map');

var _Map = _interopRequireWildcard(_map);

var _mapDifficulty = require('./map-difficulty');

var _MapDifficulty = _interopRequireWildcard(_mapDifficulty);

var _material = require('./material');

var _Material = _interopRequireWildcard(_material);

var _movie = require('./movie');

var _Movie = _interopRequireWildcard(_movie);

var _movieFileData = require('./movie-file-data');

var _MovieFileData = _interopRequireWildcard(_movieFileData);

var _movieVariation = require('./movie-variation');

var _MovieVariation = _interopRequireWildcard(_movieVariation);

var _nameGen = require('./name-gen');

var _NameGen = _interopRequireWildcard(_nameGen);

var _namesProfanity = require('./names-profanity');

var _NamesProfanity = _interopRequireWildcard(_namesProfanity);

var _namesReserved = require('./names-reserved');

var _NamesReserved = _interopRequireWildcard(_namesReserved);

var _npcSounds = require('./npc-sounds');

var _NPCSounds = _interopRequireWildcard(_npcSounds);

var _objectEffect = require('./object-effect');

var _ObjectEffect = _interopRequireWildcard(_objectEffect);

var _objectEffectGroup = require('./object-effect-group');

var _ObjectEffectGroup = _interopRequireWildcard(_objectEffectGroup);

var _objectEffectPackage = require('./object-effect-package');

var _ObjectEffectPackage = _interopRequireWildcard(_objectEffectPackage);

var _objectEffectPackageElem = require('./object-effect-package-elem');

var _ObjectEffectPackageElem = _interopRequireWildcard(_objectEffectPackageElem);

var _overrideSpellData = require('./override-spell-data');

var _OverrideSpellData = _interopRequireWildcard(_overrideSpellData);

var _package = require('./package');

var _Package = _interopRequireWildcard(_package);

var _pageTextMaterial = require('./page-text-material');

var _PageTextMaterial = _interopRequireWildcard(_pageTextMaterial);

var _paperDollItemFrame = require('./paper-doll-item-frame');

var _PaperDollItemFrame = _interopRequireWildcard(_paperDollItemFrame);

var _petPersonality = require('./pet-personality');

var _PetPersonality = _interopRequireWildcard(_petPersonality);

var _petitionType = require('./petition-type');

var _PetitionType = _interopRequireWildcard(_petitionType);

var _powerDisplay = require('./power-display');

var _PowerDisplay = _interopRequireWildcard(_powerDisplay);

var _questInfo = require('./quest-info');

var _QuestInfo = _interopRequireWildcard(_questInfo);

var _questSort = require('./quest-sort');

var _QuestSort = _interopRequireWildcard(_questSort);

var _resistances = require('./resistances');

var _Resistances = _interopRequireWildcard(_resistances);

var _screenEffect = require('./screen-effect');

var _ScreenEffect = _interopRequireWildcard(_screenEffect);

var _serverMessages = require('./server-messages');

var _ServerMessages = _interopRequireWildcard(_serverMessages);

var _skillCostsData = require('./skill-costs-data');

var _SkillCostsData = _interopRequireWildcard(_skillCostsData);

var _skillLine = require('./skill-line');

var _SkillLine = _interopRequireWildcard(_skillLine);

var _skillLineAbility = require('./skill-line-ability');

var _SkillLineAbility = _interopRequireWildcard(_skillLineAbility);

var _skillLineCategory = require('./skill-line-category');

var _SkillLineCategory = _interopRequireWildcard(_skillLineCategory);

var _skillRaceClassInfo = require('./skill-race-class-info');

var _SkillRaceClassInfo = _interopRequireWildcard(_skillRaceClassInfo);

var _skillTiers = require('./skill-tiers');

var _SkillTiers = _interopRequireWildcard(_skillTiers);

var _soundAmbience = require('./sound-ambience');

var _SoundAmbience = _interopRequireWildcard(_soundAmbience);

var _soundEmitters = require('./sound-emitters');

var _SoundEmitters = _interopRequireWildcard(_soundEmitters);

var _soundEntries = require('./sound-entries');

var _SoundEntries = _interopRequireWildcard(_soundEntries);

var _soundFilter = require('./sound-filter');

var _SoundFilter = _interopRequireWildcard(_soundFilter);

var _soundFilterElem = require('./sound-filter-elem');

var _SoundFilterElem = _interopRequireWildcard(_soundFilterElem);

var _spamMessages = require('./spam-messages');

var _SpamMessages = _interopRequireWildcard(_spamMessages);

var _spell = require('./spell');

var _Spell = _interopRequireWildcard(_spell);

var _spellCastTimes = require('./spell-cast-times');

var _SpellCastTimes = _interopRequireWildcard(_spellCastTimes);

var _spellCategory = require('./spell-category');

var _SpellCategory = _interopRequireWildcard(_spellCategory);

var _spellDescriptionVariables = require('./spell-description-variables');

var _SpellDescriptionVariables = _interopRequireWildcard(_spellDescriptionVariables);

var _spellDifficulty = require('./spell-difficulty');

var _SpellDifficulty = _interopRequireWildcard(_spellDifficulty);

var _spellDispelType = require('./spell-dispel-type');

var _SpellDispelType = _interopRequireWildcard(_spellDispelType);

var _spellDuration = require('./spell-duration');

var _SpellDuration = _interopRequireWildcard(_spellDuration);

var _spellEffectCameraShakes = require('./spell-effect-camera-shakes');

var _SpellEffectCameraShakes = _interopRequireWildcard(_spellEffectCameraShakes);

var _spellFocusObject = require('./spell-focus-object');

var _SpellFocusObject = _interopRequireWildcard(_spellFocusObject);

var _spellIcon = require('./spell-icon');

var _SpellIcon = _interopRequireWildcard(_spellIcon);

var _spellItemEnchantment = require('./spell-item-enchantment');

var _SpellItemEnchantment = _interopRequireWildcard(_spellItemEnchantment);

var _spellItemEnchantmentCondition = require('./spell-item-enchantment-condition');

var _SpellItemEnchantmentCondition = _interopRequireWildcard(_spellItemEnchantmentCondition);

var _spellMechanic = require('./spell-mechanic');

var _SpellMechanic = _interopRequireWildcard(_spellMechanic);

var _spellRadius = require('./spell-radius');

var _SpellRadius = _interopRequireWildcard(_spellRadius);

var _spellRange = require('./spell-range');

var _SpellRange = _interopRequireWildcard(_spellRange);

var _spellRuneCost = require('./spell-rune-cost');

var _SpellRuneCost = _interopRequireWildcard(_spellRuneCost);

var _spellVisualEffectName = require('./spell-visual-effect-name');

var _SpellVisualEffectName = _interopRequireWildcard(_spellVisualEffectName);

var _spellVisualKitAreaModel = require('./spell-visual-kit-area-model');

var _SpellVisualKitAreaModel = _interopRequireWildcard(_spellVisualKitAreaModel);

var _spellVisualKitModelAttach = require('./spell-visual-kit-model-attach');

var _SpellVisualKitModelAttach = _interopRequireWildcard(_spellVisualKitModelAttach);

var _spellVisualPrecastTransitions = require('./spell-visual-precast-transitions');

var _SpellVisualPrecastTransitions = _interopRequireWildcard(_spellVisualPrecastTransitions);

var _stableSlotPrices = require('./stable-slot-prices');

var _StableSlotPrices = _interopRequireWildcard(_stableSlotPrices);

var _startupStrings = require('./startup-strings');

var _Startup_Strings = _interopRequireWildcard(_startupStrings);

var _stationery = require('./stationery');

var _Stationery = _interopRequireWildcard(_stationery);

var _stringLookups = require('./string-lookups');

var _StringLookups = _interopRequireWildcard(_stringLookups);

var _talent = require('./talent');

var _Talent = _interopRequireWildcard(_talent);

var _talentTab = require('./talent-tab');

var _TalentTab = _interopRequireWildcard(_talentTab);

var _taxiNodes = require('./taxi-nodes');

var _TaxiNodes = _interopRequireWildcard(_taxiNodes);

var _taxiPath = require('./taxi-path');

var _TaxiPath = _interopRequireWildcard(_taxiPath);

var _taxiPathNode = require('./taxi-path-node');

var _TaxiPathNode = _interopRequireWildcard(_taxiPathNode);

var _teamContributionPoints = require('./team-contribution-points');

var _TeamContributionPoints = _interopRequireWildcard(_teamContributionPoints);

var _terrainType = require('./terrain-type');

var _TerrainType = _interopRequireWildcard(_terrainType);

var _terrainTypeSounds = require('./terrain-type-sounds');

var _TerrainTypeSounds = _interopRequireWildcard(_terrainTypeSounds);

var _totemCategory = require('./totem-category');

var _TotemCategory = _interopRequireWildcard(_totemCategory);

var _transportAnimation = require('./transport-animation');

var _TransportAnimation = _interopRequireWildcard(_transportAnimation);

var _uiSoundLookups = require('./ui-sound-lookups');

var _UISoundLookups = _interopRequireWildcard(_uiSoundLookups);

var _vehicleUiIndSeat = require('./vehicle-ui-ind-seat');

var _VehicleUIIndSeat = _interopRequireWildcard(_vehicleUiIndSeat);

var _vehicleUiIndicator = require('./vehicle-ui-indicator');

var _VehicleUIIndicator = _interopRequireWildcard(_vehicleUiIndicator);

var _vocalUiSounds = require('./vocal-ui-sounds');

var _VocalUISounds = _interopRequireWildcard(_vocalUiSounds);

var _weather = require('./weather');

var _Weather = _interopRequireWildcard(_weather);

var _wmoAreaTable = require('./wmo-area-table');

var _WMOAreaTable = _interopRequireWildcard(_wmoAreaTable);

var _worldMapArea = require('./world-map-area');

var _WorldMapArea = _interopRequireWildcard(_worldMapArea);

var _worldMapContinent = require('./world-map-continent');

var _WorldMapContinent = _interopRequireWildcard(_worldMapContinent);

var _worldMapOverlay = require('./world-map-overlay');

var _WorldMapOverlay = _interopRequireWildcard(_worldMapOverlay);

var _worldMapTransforms = require('./world-map-transforms');

var _WorldMapTransforms = _interopRequireWildcard(_worldMapTransforms);

var _worldSafeLocs = require('./world-safe-locs');

var _WorldSafeLocs = _interopRequireWildcard(_worldSafeLocs);

var _worldStateUi = require('./world-state-ui');

var _WorldStateUI = _interopRequireWildcard(_worldStateUi);

var _worldStateZoneSounds = require('./world-state-zone-sounds');

var _WorldStateZoneSounds = _interopRequireWildcard(_worldStateZoneSounds);

var _wowErrorStrings = require('./wow-error-strings');

var _WowError_Strings = _interopRequireWildcard(_wowErrorStrings);

var _zoneIntroMusicTable = require('./zone-intro-music-table');

var _ZoneIntroMusicTable = _interopRequireWildcard(_zoneIntroMusicTable);

var _zoneMusic = require('./zone-music');

var _ZoneMusic = _interopRequireWildcard(_zoneMusic);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

exports.Achievement = _Achievement;
exports.Achievement_Category = _Achievement_Category;
exports.Achievement_Criteria = _Achievement_Criteria;
exports.AnimationData = _AnimationData;
exports.AreaGroup = _AreaGroup;
exports.AreaPOI = _AreaPOI;
exports.AreaTable = _AreaTable;
exports.AreaTrigger = _AreaTrigger;
exports.AttackAnimKits = _AttackAnimKits;
exports.AttackAnimTypes = _AttackAnimTypes;
exports.AuctionHouse = _AuctionHouse;
exports.BankBagSlotPrices = _BankBagSlotPrices;
exports.BannedAddOns = _BannedAddOns;
exports.BarberShopStyle = _BarberShopStyle;
exports.BattlemasterList = _BattlemasterList;
exports.CameraShakes = _CameraShakes;
exports.Cfg_Categories = _Cfg_Categories;
exports.Cfg_Configs = _Cfg_Configs;
exports.CharBaseInfo = _CharBaseInfo;
exports.CharHairGeosets = _CharHairGeosets;
exports.CharSections = _CharSections;
exports.CharStartOutfit = _CharStartOutfit;
exports.CharTitles = _CharTitles;
exports.CharacterFacialHairStyles = _CharacterFacialHairStyles;
exports.ChatChannels = _ChatChannels;
exports.ChatProfanity = _ChatProfanity;
exports.ChrClasses = _ChrClasses;
exports.ChrRaces = _ChrRaces;
exports.CinematicCamera = _CinematicCamera;
exports.CinematicSequences = _CinematicSequences;
exports.CreatureDisplayInfo = _CreatureDisplayInfo;
exports.CreatureDisplayInfoExtra = _CreatureDisplayInfoExtra;
exports.CreatureFamily = _CreatureFamily;
exports.CreatureModelData = _CreatureModelData;
exports.CreatureMovementInfo = _CreatureMovementInfo;
exports.CreatureSpellData = _CreatureSpellData;
exports.CreatureType = _CreatureType;
exports.CurrencyCategory = _CurrencyCategory;
exports.CurrencyTypes = _CurrencyTypes;
exports.DanceMoves = _DanceMoves;
exports.DeclinedWord = _DeclinedWord;
exports.DeclinedWordCases = _DeclinedWordCases;
exports.DungeonEncounter = _DungeonEncounter;
exports.DungeonMap = _DungeonMap;
exports.DungeonMapChunk = _DungeonMapChunk;
exports.Emotes = _Emotes;
exports.EmotesText = _EmotesText;
exports.EmotesTextData = _EmotesTextData;
exports.EmotesTextSound = _EmotesTextSound;
exports.EnvironmentalDamage = _EnvironmentalDamage;
exports.Exhaustion = _Exhaustion;
exports.Faction = _Faction;
exports.FactionGroup = _FactionGroup;
exports.FactionTemplate = _FactionTemplate;
exports.FileData = _FileData;
exports.FootprintTextures = _FootprintTextures;
exports.GameObjectArtKit = _GameObjectArtKit;
exports.GameObjectDisplayInfo = _GameObjectDisplayInfo;
exports.GameTips = _GameTips;
exports.HolidayDescriptions = _HolidayDescriptions;
exports.HolidayNames = _HolidayNames;
exports.Item = _Item;
exports.ItemBagFamily = _ItemBagFamily;
exports.ItemClass = _ItemClass;
exports.ItemDisplayInfo = _ItemDisplayInfo;
exports.ItemExtendedCost = _ItemExtendedCost;
exports.ItemPetFood = _ItemPetFood;
exports.ItemPurchaseGroup = _ItemPurchaseGroup;
exports.ItemRandomProperties = _ItemRandomProperties;
exports.ItemRandomSuffix = _ItemRandomSuffix;
exports.ItemSet = _ItemSet;
exports.ItemSubClass = _ItemSubClass;
exports.ItemSubClassMask = _ItemSubClassMask;
exports.ItemVisualEffects = _ItemVisualEffects;
exports.ItemVisuals = _ItemVisuals;
exports.LanguageWords = _LanguageWords;
exports.Languages = _Languages;
exports.Light = _Light;
exports.LightFloatBand = _LightFloatBand;
exports.LightIntBand = _LightIntBand;
exports.LightParams = _LightParams;
exports.LightSkybox = _LightSkybox;
exports.LiquidMaterial = _LiquidMaterial;
exports.LiquidType = _LiquidType;
exports.LoadingScreens = _LoadingScreens;
exports.Lock = _Lock;
exports.LockType = _LockType;
exports.MailTemplate = _MailTemplate;
exports.Map = _Map;
exports.MapDifficulty = _MapDifficulty;
exports.Material = _Material;
exports.Movie = _Movie;
exports.MovieFileData = _MovieFileData;
exports.MovieVariation = _MovieVariation;
exports.NameGen = _NameGen;
exports.NamesProfanity = _NamesProfanity;
exports.NamesReserved = _NamesReserved;
exports.NPCSounds = _NPCSounds;
exports.ObjectEffect = _ObjectEffect;
exports.ObjectEffectGroup = _ObjectEffectGroup;
exports.ObjectEffectPackage = _ObjectEffectPackage;
exports.ObjectEffectPackageElem = _ObjectEffectPackageElem;
exports.OverrideSpellData = _OverrideSpellData;
exports.Package = _Package;
exports.PageTextMaterial = _PageTextMaterial;
exports.PaperDollItemFrame = _PaperDollItemFrame;
exports.PetPersonality = _PetPersonality;
exports.PetitionType = _PetitionType;
exports.PowerDisplay = _PowerDisplay;
exports.QuestInfo = _QuestInfo;
exports.QuestSort = _QuestSort;
exports.Resistances = _Resistances;
exports.ScreenEffect = _ScreenEffect;
exports.ServerMessages = _ServerMessages;
exports.SkillCostsData = _SkillCostsData;
exports.SkillLine = _SkillLine;
exports.SkillLineAbility = _SkillLineAbility;
exports.SkillLineCategory = _SkillLineCategory;
exports.SkillRaceClassInfo = _SkillRaceClassInfo;
exports.SkillTiers = _SkillTiers;
exports.SoundAmbience = _SoundAmbience;
exports.SoundEmitters = _SoundEmitters;
exports.SoundEntries = _SoundEntries;
exports.SoundFilter = _SoundFilter;
exports.SoundFilterElem = _SoundFilterElem;
exports.SpamMessages = _SpamMessages;
exports.Spell = _Spell;
exports.SpellCastTimes = _SpellCastTimes;
exports.SpellCategory = _SpellCategory;
exports.SpellDescriptionVariables = _SpellDescriptionVariables;
exports.SpellDifficulty = _SpellDifficulty;
exports.SpellDispelType = _SpellDispelType;
exports.SpellDuration = _SpellDuration;
exports.SpellEffectCameraShakes = _SpellEffectCameraShakes;
exports.SpellFocusObject = _SpellFocusObject;
exports.SpellIcon = _SpellIcon;
exports.SpellItemEnchantment = _SpellItemEnchantment;
exports.SpellItemEnchantmentCondition = _SpellItemEnchantmentCondition;
exports.SpellMechanic = _SpellMechanic;
exports.SpellRadius = _SpellRadius;
exports.SpellRange = _SpellRange;
exports.SpellRuneCost = _SpellRuneCost;
exports.SpellVisualEffectName = _SpellVisualEffectName;
exports.SpellVisualKitAreaModel = _SpellVisualKitAreaModel;
exports.SpellVisualKitModelAttach = _SpellVisualKitModelAttach;
exports.SpellVisualPrecastTransitions = _SpellVisualPrecastTransitions;
exports.StableSlotPrices = _StableSlotPrices;
exports.Startup_Strings = _Startup_Strings;
exports.Stationery = _Stationery;
exports.StringLookups = _StringLookups;
exports.Talent = _Talent;
exports.TalentTab = _TalentTab;
exports.TaxiNodes = _TaxiNodes;
exports.TaxiPath = _TaxiPath;
exports.TaxiPathNode = _TaxiPathNode;
exports.TeamContributionPoints = _TeamContributionPoints;
exports.TerrainType = _TerrainType;
exports.TerrainTypeSounds = _TerrainTypeSounds;
exports.TotemCategory = _TotemCategory;
exports.TransportAnimation = _TransportAnimation;
exports.UISoundLookups = _UISoundLookups;
exports.VehicleUIIndSeat = _VehicleUIIndSeat;
exports.VehicleUIIndicator = _VehicleUIIndicator;
exports.VocalUISounds = _VocalUISounds;
exports.Weather = _Weather;
exports.WMOAreaTable = _WMOAreaTable;
exports.WorldMapArea = _WorldMapArea;
exports.WorldMapContinent = _WorldMapContinent;
exports.WorldMapOverlay = _WorldMapOverlay;
exports.WorldMapTransforms = _WorldMapTransforms;
exports.WorldSafeLocs = _WorldSafeLocs;
exports.WorldStateUI = _WorldStateUI;
exports.WorldStateZoneSounds = _WorldStateZoneSounds;
exports.WowError_Strings = _WowError_Strings;
exports.ZoneIntroMusicTable = _ZoneIntroMusicTable;
exports.ZoneMusic = _ZoneMusic;