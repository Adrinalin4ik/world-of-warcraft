import { LuaVM } from '../vm';
import { installLoginApi } from '../api/login';
import { installRealmsApi } from '../api/realms';
import { ProtocolSession } from '../../../../../network/protocol/session';
import { RealmInfo } from '../../../../../network/protocol/types';

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
});
