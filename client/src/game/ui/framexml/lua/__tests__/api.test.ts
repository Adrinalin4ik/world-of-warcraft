import { LuaVM } from '../vm';
import { installLoginApi } from '../api/login';
import { ProtocolSession } from '../../../../../network/protocol/session';

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
});
