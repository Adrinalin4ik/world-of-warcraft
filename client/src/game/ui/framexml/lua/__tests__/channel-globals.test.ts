import { LuaVM } from '../vm';
import { installChatApi } from '../api/chat';

/**
 * THE CHANNEL GLOBALS EXIST AS SOON AS THE API IS INSTALLED, with no session behind them.
 *
 * This guards a regression I shipped. Registering them in `channel-bridge.ts` instead put them in
 * existence only AFTER the manifest, and the chat bridge fires `UPDATE_CHAT_WINDOWS` before that -- whose
 * arm calls `ChatFrame_RegisterForChannels(self, GetChatWindowChannels(self:GetID()))`
 * (`chatframe.lua:2511`). A nil global throws there, `ChatFrame_OnEvent` aborts,
 * `FloatingChatFrame_OnEvent` never runs, and the chat window never gets its colour or its alpha: the
 * owner saw a WHITE BOX, which is the third time that exact symptom has come from a nil name in this
 * one path.
 *
 * So the assertion is EXISTENCE AND SHAPE WITH NO SINK -- the state during the manifest -- and not that
 * channels work. `GetChannelName` answering the number 0 rather than nil is part of the shape:
 * `itemref.lua:164` compares `== 0` and would raise on a nil.
 */
test('the channel globals answer before any session exists', () => {
  const vm = new LuaVM();
  installChatApi(vm);

  const error = vm.run(
    `joinType = type(JoinPermanentChannel)
     leaveType = type(LeaveChannelByName)
     windowChannels = select('#', GetChatWindowChannels(1))
     listed = select('#', GetChannelList())
     displayed = GetNumDisplayChannels()
     byNumber = GetChannelName(1)
     byName = GetChannelName("General")`,
    'channel-globals',
  );

  expect(error).toBeNull();
  expect(vm.getGlobal('joinType')).toBe('function');
  expect(vm.getGlobal('leaveType')).toBe('function');
  // No sink: no channels, and every list is empty rather than absent.
  expect(vm.getGlobal('windowChannels')).toBe(0);
  expect(vm.getGlobal('listed')).toBe(0);
  expect(vm.getGlobal('displayed')).toBe(0);
  // A NUMBER, not nil -- see the header.
  expect(vm.getGlobal('byNumber')).toBe(0);
  expect(vm.getGlobal('byName')).toBe(0);
});
