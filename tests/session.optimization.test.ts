import { sessionManager } from '../src/shared/session';
import { ConversationStateEnum } from '../src/shared/session';

jest.mock('../src/config/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

describe('setState optimization', () => {
  it('calls getSession internally (read-modify-write pattern)', async () => {
    (sessionManager as any).getSession = jest.fn().mockResolvedValue({
      phoneNumber: '221771234567',
      state: ConversationStateEnum.IDLE,
      lastActivity: Date.now(),
    });
    (sessionManager as any).write = jest.fn().mockResolvedValue(undefined);
    await sessionManager.setState('221771234567', ConversationStateEnum.IDLE);
    expect((sessionManager as any).getSession).toHaveBeenCalledWith('221771234567');
    expect((sessionManager as any).write).toHaveBeenCalled();
  });
});
