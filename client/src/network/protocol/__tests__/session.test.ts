import { ProtocolSession, RETRY_DELAY_MS } from '../session';
import { LoginStage } from '../stages';
import { ProtocolRefusalError } from '../types';

function fakeLogon() {
  return {
    authenticate: jest.fn(async () => ({ sessionKey: new Uint8Array(40) })),
    realms: jest.fn(async () => [
      {
        id: 1,
        name: 'Test',
        host: 'realm.example.com',
        port: 8085,
        population: 1,
        characterCount: 0,
        online: true,
        recommended: false,
        pvp: false,
      },
    ]),
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

describe('ProtocolSession', () => {
  it('starts offline', () => {
    expect(new ProtocolSession(fakeLogon(), fakeWorld()).stage).toBe(LoginStage.Offline);
  });

  it('walks the stages in order on a clean login', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    const seen: LoginStage[] = [];
    session.on((state) => seen.push(state.stage));

    await session.login('tester', 'secret');

    expect(seen).toEqual([
      LoginStage.Connecting,
      LoginStage.Authenticating,
      LoginStage.RealmList,
    ]);
    expect(session.realms).toHaveLength(1);
  });

  it('reaches the character list once a realm is chosen', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    await session.login('tester', 'secret');

    await session.chooseRealm(session.realms[0]);

    expect(session.stage).toBe(LoginStage.CharacterList);
  });

  it('reaches the world', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);

    await session.enterWorld('0x1');

    expect(session.stage).toBe(LoginStage.InWorld);
    expect(world.enterWorld).toHaveBeenCalledWith('0x1');
  });

  it('refreshes the roster after a create and after a delete', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);

    await session.createCharacter({
      name: 'Newbie',
      race: 1,
      class: 1,
      gender: 0,
      appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
      outfitId: 0,
    });
    await session.deleteCharacter('0x1');

    // Once on entering the list, once per mutation: the roster is never guessed at locally.
    expect(world.characters).toHaveBeenCalledTimes(3);
  });

  it('keeps the refusal and goes back offline when the server refuses', async () => {
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValue(
      new ProtocolRefusalError({ code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' }),
    );
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'wrong')).rejects.toBeInstanceOf(ProtocolRefusalError);

    expect(session.stage).toBe(LoginStage.Offline);
    expect(session.lastRefusal).toEqual({ code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' });
  });

  it('NEVER resubmits after a refusal, however long you wait', async () => {
    jest.useFakeTimers();
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValue(
      new ProtocolRefusalError({ code: 0x05, stringKey: 'AUTH_INCORRECT_PASSWORD' }),
    );
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'wrong')).rejects.toBeInstanceOf(ProtocolRefusalError);
    jest.advanceTimersByTime(RETRY_DELAY_MS * 10);
    await Promise.resolve();

    // One attempt, ever. On vmangos an 0x05 locks the account out; a retry loop is how that happens.
    expect(logon.authenticate).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('retries a TRANSPORT failure once per retry delay while credentials stand', async () => {
    jest.useFakeTimers();
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValueOnce(new Error('socket closed'));
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'secret')).rejects.toThrow(/socket closed/);
    expect(logon.authenticate).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(RETRY_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(logon.authenticate).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('hands every listener the same state object shape', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    const states: any[] = [];
    const unsubscribe = session.on((state) => states.push(state));

    await session.login('tester', 'secret');
    unsubscribe();
    await session.chooseRealm(session.realms[0]);

    expect(Object.keys(states[0]).sort()).toEqual(['characters', 'realms', 'refusal', 'stage']);
    // Unsubscribed: nothing after the realm choice.
    expect(states.some((state) => state.stage === LoginStage.CharacterList)).toBe(false);
  });

  it('rejects createCharacter before a realm is joined, naming the missing step', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    await session.login('tester', 'secret');

    await expect(
      session.createCharacter({
        name: 'Newbie',
        race: 1,
        class: 1,
        gender: 0,
        appearance: { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 },
        outfitId: 0,
      }),
    ).rejects.toThrow(/joining a realm/);
  });

  it('rejects deleteCharacter before a realm is joined, naming the missing step', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    await session.login('tester', 'secret');

    await expect(session.deleteCharacter('0x1')).rejects.toThrow(/joining a realm/);
  });

  it('rejects enterWorld before a realm is joined, naming the missing step', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    await session.login('tester', 'secret');

    await expect(session.enterWorld('0x1')).rejects.toThrow(/joining a realm/);
  });

  it('leaves the stage at RealmList when the realm join is refused', async () => {
    const world = fakeWorld();
    world.join.mockRejectedValueOnce(new Error('join refused'));
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');

    await expect(session.chooseRealm(session.realms[0])).rejects.toThrow(/join refused/);

    expect(session.stage).toBe(LoginStage.RealmList);
  });

  it('leaves the stage at CharacterList when entering the world is refused', async () => {
    const world = fakeWorld();
    world.enterWorld.mockRejectedValueOnce(new Error('entry refused'));
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);

    await expect(session.enterWorld('0x1')).rejects.toThrow(/entry refused/);

    expect(session.stage).toBe(LoginStage.CharacterList);
  });

  it('does not let a caller mutate the roster by mutating the returned array', async () => {
    const session = new ProtocolSession(fakeLogon(), fakeWorld());
    await session.login('tester', 'secret');

    const realms = session.realms;
    realms.push({ ...realms[0], id: 999 });

    expect(session.realms).toHaveLength(1);
  });

  it('replaces a pending retry rather than stacking with it when login is called again', async () => {
    jest.useFakeTimers();
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValueOnce(new Error('socket closed'));
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'secret')).rejects.toThrow(/socket closed/);
    expect(logon.authenticate).toHaveBeenCalledTimes(1);

    // Manually retry before the scheduled retry fires.
    await session.login('tester', 'secret');
    expect(logon.authenticate).toHaveBeenCalledTimes(2);

    // The stale timer must not survive to fire a third attempt.
    jest.advanceTimersByTime(RETRY_DELAY_MS * 10);
    await Promise.resolve();
    expect(logon.authenticate).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});
