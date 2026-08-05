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
  const disconnectListeners: Array<(reason: string) => void> = [];
  return {
    join: jest.fn(async () => undefined),
    characters: jest.fn(async () => []),
    createCharacter: jest.fn(async () => undefined),
    deleteCharacter: jest.fn(async () => undefined),
    enterWorld: jest.fn(async () => undefined),
    close: jest.fn(),
    onDisconnect: jest.fn((listener: (reason: string) => void) => {
      disconnectListeners.push(listener);
    }),
    // Test-only hook: simulate the transport dropping out from under the session.
    disconnect(reason: string) {
      disconnectListeners.forEach((listener) => listener(reason));
    },
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

  it('stop() cancels a pending retry so it never fires', async () => {
    jest.useFakeTimers();
    const logon = fakeLogon();
    logon.authenticate.mockRejectedValueOnce(new Error('socket closed'));
    const session = new ProtocolSession(logon, fakeWorld());

    await expect(session.login('tester', 'secret')).rejects.toThrow(/socket closed/);
    expect(logon.authenticate).toHaveBeenCalledTimes(1);

    session.stop();
    jest.advanceTimersByTime(RETRY_DELAY_MS * 10);
    await Promise.resolve();
    await Promise.resolve();

    // The retry that was queued must never fire once stopped.
    expect(logon.authenticate).toHaveBeenCalledTimes(1);
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

  it('leaves the stage at CharacterList when a second realm join fails', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);
    expect(session.stage).toBe(LoginStage.CharacterList);

    world.join.mockRejectedValueOnce(new Error('second join refused'));

    await expect(session.chooseRealm(session.realms[0])).rejects.toThrow(/second join refused/);

    // Nothing about the roster changed: the machine must not claim it did.
    expect(session.stage).toBe(LoginStage.CharacterList);
  });

  it('leaves the stage at InWorld when a second world entry fails', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);
    await session.enterWorld('0x1');
    expect(session.stage).toBe(LoginStage.InWorld);

    world.enterWorld.mockRejectedValueOnce(new Error('second entry refused'));

    await expect(session.enterWorld('0x2')).rejects.toThrow(/second entry refused/);

    expect(session.stage).toBe(LoginStage.InWorld);
  });

  it('clears the joined flag on a world disconnect, so a later mutation hits the guard', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);

    world.disconnect('socket closed');

    await expect(session.deleteCharacter('0x1')).rejects.toThrow(/joining a realm/);
    // The guard must fire before the transport is ever touched.
    expect(world.deleteCharacter).not.toHaveBeenCalled();
  });

  it('moves the stage to RealmList on a world disconnect while the session key still stands', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);

    world.disconnect('socket closed');

    expect(session.stage).toBe(LoginStage.RealmList);
  });

  it('does not let a stale disconnect from an earlier connection resurrect RealmList after a refusal', async () => {
    const world = fakeWorld();
    const logon = fakeLogon();
    const session = new ProtocolSession(logon, world);

    // First login succeeds: a session key now stands.
    await session.login('tester', 'secret');
    expect(session.stage).toBe(LoginStage.RealmList);

    // A fresh login attempt is refused.
    logon.authenticate.mockRejectedValueOnce(
      new ProtocolRefusalError({ code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' }),
    );
    await expect(session.login('tester', 'wrong')).rejects.toBeInstanceOf(ProtocolRefusalError);
    expect(session.stage).toBe(LoginStage.Offline);

    // The earlier connection's disconnect notification arrives late. It must not read the stale
    // key and invite the player to pick a realm right after telling them the account was refused.
    world.disconnect('stale connection closed');

    expect(session.stage).toBe(LoginStage.Offline);
  });

  it('sets Offline on a disconnect with no session key standing', () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);

    world.disconnect('closed before any login');

    expect(session.stage).toBe(LoginStage.Offline);
  });

  it('lets a disconnect landing mid-chooseRealm survive that operation rejecting', async () => {
    const world = fakeWorld();
    const session = new ProtocolSession(fakeLogon(), world);
    await session.login('tester', 'secret');
    await session.chooseRealm(session.realms[0]);
    expect(session.stage).toBe(LoginStage.CharacterList);

    // The world drops WHILE the second join is in flight, then that join call itself rejects.
    world.join.mockImplementationOnce(async () => {
      world.disconnect('dropped mid-join');
      throw new Error('join failed after the disconnect');
    });

    await expect(session.chooseRealm(session.realms[0])).rejects.toThrow(
      /join failed after the disconnect/,
    );

    // The disconnect's RealmList must stand -- the rejection's rollback must not resurrect the
    // CharacterList that was current before this attempt, since that state is now stale.
    expect(session.stage).toBe(LoginStage.RealmList);
    // And joined must still read false: a following mutation must still hit the guard.
    await expect(session.deleteCharacter('0x1')).rejects.toThrow(/joining a realm/);
  });
});
