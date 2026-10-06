import axios from 'axios';

import { config } from '../src/config/env';
import { MessageSender } from '../src/shared/sender';
import { history } from '../src/shared/history';
import { checkWindowCompliance } from '../src/shared/meta.compliance';

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    post: jest.fn().mockResolvedValue({ data: { success: true } }),
  })),
}));

jest.mock('../src/config/logger', () => ({
  logger: { warn: jest.fn() },
}));

jest.mock('../src/shared/history', () => ({
  history: { append: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../src/shared/meta.compliance', () => ({
  checkMessageCompliance: jest.fn().mockReturnValue({ valid: true }),
  checkWindowCompliance: jest.fn().mockResolvedValue({ status: 'IN_WINDOW' }),
  isInternalRecipient: jest.fn().mockReturnValue(false),
  logConversation: jest.fn().mockResolvedValue(undefined),
  enforceOptIn: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/modules/delivery/delivery.service', () => ({
  isRegisteredLivreur: jest.fn().mockResolvedValue(false),
}));

describe('MessageSender.sendText', () => {
  it('envoie le texte via Evolution après vérification de la fenêtre de service', async () => {
    const phone = '221771234567';
    const text = 'Bonjour';
    const client = {
      post: jest.fn().mockResolvedValue({ data: { success: true } }),
    };
    jest.mocked(axios.create).mockReturnValue(client as never);
    const sender = new MessageSender();
    await sender.sendText(phone, text);

    expect(checkWindowCompliance).toHaveBeenCalledWith(phone);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      `/message/sendText/${config.evolution.instanceName}`,
      { number: phone, text },
    );
    expect(history.append).toHaveBeenCalledWith(phone, {
      fromMe: true,
      text,
      type: 'text',
    });
  });
});