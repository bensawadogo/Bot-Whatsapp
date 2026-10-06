import { prisma } from '../src/config/database';
import { logConversation } from '../src/shared/meta.compliance';

jest.mock('../src/config/database', () => ({
  prisma: { conversationLog: { create: jest.fn() } },
}));

describe('logConversation guard', () => {
  it('accepts null text', async () => {
    (prisma.conversationLog.create as jest.Mock).mockResolvedValue({ id: '1'});
    await logConversation({ phone: '221771234567', fromMe: true, text: null as unknown as string, type: 'text' });
    expect(prisma.conversationLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversationLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ text: '' }) }));
  });
});
