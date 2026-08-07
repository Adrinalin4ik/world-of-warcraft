import { LuaVM } from '../vm';
import { FrameRegistry, installObjectModel } from '../object';
import { installCharactersApi } from '../api/characters';
import { installLoginApi } from '../api/login';
import { installRealmsApi } from '../api/realms';
import { ProtocolSession } from '../../../../../network/protocol/session';
import { CharacterRecord, RealmInfo } from '../../../../../network/protocol/types';

/** The project owner's own two realms, which is what the browser pass runs against. */
const REALMS: RealmInfo[] = [
  {
    id: 1,
    name: 'Медив (x1)',
    host: 'logon.example.ru',
    port: 8085,
    population: 0,
    characterCount: 1,
    online: true,
    recommended: false,
    pvp: true,
    rp: false,
    locked: false,
    invalid: false,
  },
  {
    id: 2,
    name: 'Азшара (PTR)',
    host: 'logon.example.ru',
    port: 8086,
    population: 0,
    characterCount: 0,
    online: true,
    recommended: false,
    pvp: true,
    rp: false,
    locked: true,
    invalid: false,
  },
];

/**
 * The synthetic roster. Three characters of different race, class, level and zone -- the same shape the
 * browser pass stages into `ProtocolSession`, kept here so the tuple assertion below reads against
 * something recognisable rather than three copies of the same character.
 */
const APPEARANCE = { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 };
const ROSTER: CharacterRecord[] = [
  {
    guid: '0x1',
    name: 'Thrallmar',
    race: 2, // Orc
    class: 1, // Warrior
    gender: 0,
    level: 80,
    appearance: APPEARANCE,
    zoneId: 4395, // Dalaran
    mapId: 571,
    position: [0, 0, 0],
    guildId: 0,
    flags: 0,
    equipment: [],
  },
  {
    guid: '0x2',
    name: 'Lightsong',
    race: 11, // Draenei
    class: 6, // Death Knight
    gender: 1,
    level: 58,
    appearance: APPEARANCE,
    zoneId: 3524, // Azuremyst Isle
    mapId: 530,
    position: [0, 0, 0],
    guildId: 0,
    // `CHARACTER_FLAG_GHOST` -- the bit `GetCharacterInfo`'s seventh value reports.
    flags: 0x2000,
    equipment: [],
  },
  {
    guid: '0x3',
    name: 'Sapling',
    race: 4, // Night Elf
    class: 11, // Druid
    gender: 0,
    level: 5,
    appearance: APPEARANCE,
    zoneId: 141, // Teldrassil
    mapId: 1,
    position: [0, 0, 0],
    guildId: 0,
    flags: 0,
    equipment: [],
  },
];

function fakeLogon() {
  return {
    authenticate: jest.fn(async () => ({ sessionKey: new Uint8Array(40) })),
    realms: jest.fn(async () => []),
    close: jest.fn(),
  };
}

function fakeWorld() {
  return {
    join: jest.fn(async () => undefined),
    characters: jest.fn(async () => []),
    createCharacter: jest.fn(async () => undefined),
    deleteCharacter: jest.fn(async () => undefined),
    enterWorld: jest.fn(async () => undefined),
    close: jest.fn(),
    onDisconnect: jest.fn(),
  };
}

describe('engine api', () => {
  it('DefaultServerLogin reaches ProtocolSession#login with the typed account and password', () => {
    const vm = new LuaVM();
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    const login = jest.spyOn(session, 'login').mockResolvedValue(undefined);
    installLoginApi(vm, session);

    const error = vm.run(`DefaultServerLogin("myaccount", "mypassword")`, 'api.test.lua');

    expect(error).toBeNull();
    expect(login).toHaveBeenCalledWith('myaccount', 'mypassword');

    vm.dispose();
  });

  it('the realm list reads through one ORDERED view, which SortRealms moves', () => {
    const vm = new LuaVM();
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    // The session's realms are its own; the presentation ORDER is this API's.
    jest.spyOn(session, 'realms', 'get').mockReturnValue(REALMS);
    const chooseRealm = jest.spyOn(session, 'chooseRealm').mockResolvedValue(undefined);
    installRealmsApi(vm, session);

    // Unsorted, the server's own order -- what a freshly-shown list uses.
    expect(vm.runExpr('return GetNumRealms(1)', 'n.lua')).toEqual({ value: 2 });
    expect(vm.runExpr('return (GetRealmInfo(1, 1))', 'a.lua')).toEqual({ value: 'Медив (x1)' });
    expect(vm.runExpr('return select(9, GetRealmInfo(1, 2))', 'lock.lua')).toEqual({ value: true });

    // Sorted by name, `Азшара` before `Медив` -- and `ChangeRealm` must agree, because the row buttons
    // are `SetID`'d with an index into this same view and `RealmList_OnOk` feeds it straight back.
    expect(vm.run('SortRealms("name")', 's.lua')).toBeNull();
    expect(vm.runExpr('return (GetRealmInfo(1, 1))', 'b.lua')).toEqual({ value: 'Азшара (PTR)' });
    expect(vm.run('ChangeRealm(1, 1)', 'c.lua')).toBeNull();
    expect(chooseRealm).toHaveBeenCalledWith(REALMS[1]);

    vm.dispose();
  });

  /**
   * THE tuple. The Lua below is characterselect.lua:314 copied verbatim, because that line is the
   * specification: a shifted tuple puts the level in the zone column and renders a plausible wrong
   * screen with no error anywhere.
   *
   * `zone` is `nil` here and that is correct rather than a hole in the test -- it comes from
   * `AreaTable.dbc`, which no jest environment fetches, and the client's own next two lines are
   * `if ( not zone ) then zone = "" end`. What this pins is its POSITION, which is the thing that
   * breaks.
   */
  it('GetCharacterInfo answers characterselect.lua:314 value for value', () => {
    const vm = new LuaVM();
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    jest.spyOn(session, 'characters', 'get').mockReturnValue(ROSTER);
    installCharactersApi(vm, session);

    expect(vm.runExpr('return GetNumCharacters()', 'n.lua')).toEqual({ value: 3 });

    const tuple = `
      local name, race, class, level, zone, sex, ghost, PCC, PRC, PFC = GetCharacterInfo(%d);
      return table.concat({ tostring(name), tostring(race), tostring(class), tostring(level),
        tostring(zone), tostring(sex), tostring(ghost), tostring(PCC), tostring(PRC),
        tostring(PFC) }, "|")
    `;
    expect(vm.runExpr(tuple.replace('%d', '1'), 'c1.lua')).toEqual({
      value: 'Thrallmar|Orc|Warrior|80|nil|0|false|false|false|false',
    });
    // A ghost, a female Draenei, and a class whose name is two words -- the three things a naive
    // implementation gets wrong (a raw flags word, a gender byte dropped, an id where a name belongs).
    expect(vm.runExpr(tuple.replace('%d', '2'), 'c2.lua')).toEqual({
      value: 'Lightsong|Draenei|Death Knight|58|nil|1|true|false|false|false',
    });

    // The client formats level and class through `"Level %d %s"` (gluestrings.lua:162), so a numeric
    // class id here would render "Level 5 11" and never raise.
    expect(
      vm.runExpr(
        'local _, _, class, level = GetCharacterInfo(3); return string.format("Level %d %s", level, class)',
        'fmt.lua',
      ),
    ).toEqual({ value: 'Level 5 Druid' });

    vm.dispose();
  });

  /**
   * The SELECTION is the engine's, not the screen's. `EnterWorld()` takes no argument, so whatever
   * `SelectCharacter` last stored is what the player enters the world as -- and the screen only learns
   * of it through the `UPDATE_SELECTED_CHARACTER` event this fires.
   */
  it('SelectCharacter announces the index, and EnterWorld enters as that character', () => {
    const vm = new LuaVM();
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    jest.spyOn(session, 'characters', 'get').mockReturnValue(ROSTER);
    const enterWorld = jest.spyOn(session, 'enterWorld').mockResolvedValue(undefined);
    const registry = new FrameRegistry();
    installObjectModel(vm, registry);
    installCharactersApi(vm, session);

    // A listener registered the way `CharacterSelect_OnLoad` registers it, so the event path is the
    // real one rather than a direct call.
    expect(
      vm.run(
        `SEEN = nil;
         Watcher = CreateFrame("Frame", "Watcher");
         Watcher:RegisterEvent("UPDATE_SELECTED_CHARACTER");
         Watcher:SetScript("OnEvent", function(self, event, index) SEEN = index end);
         SelectCharacter(2)`,
        'select.lua',
      ),
    ).toBeNull();
    expect(vm.runExpr('return SEEN', 'seen.lua')).toEqual({ value: 2 });

    expect(vm.run('EnterWorld()', 'enter.lua')).toBeNull();
    expect(enterWorld).toHaveBeenCalledWith(ROSTER[1].guid);

    // The module-level side tables in `methods/*` are keyed by an id that restarts at 1 per registry,
    // so a registry left un-reset hands the NEXT test's frame this one's stale entries (fix round 5).
    registry.reset();
    vm.dispose();
  });
});
