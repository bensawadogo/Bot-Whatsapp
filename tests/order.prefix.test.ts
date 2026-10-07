jest.mock('../src/config/database', () => ({
  prisma: { order: { findMany: jest.fn() } },
}));

import { findOrderByIdPrefix } from '../src/modules/orders/order.service';

describe('findOrderByIdPrefix', () => {
  it('returns null for short prefix', async () => {
    const result = await findOrderByIdPrefix('ab');
    expect(result).toBeNull();
  });

  it('returns null when no order matches', async () => {
    const { prisma } = require('../src/config/database');
    (prisma.order.findMany as jest.Mock).mockResolvedValue([]);
    const result = await findOrderByIdPrefix('abcdef123456');
    expect(result).toBeNull();
  });

  it('returns the order when exactly one matches', async () => {
    const { prisma } = require('../src/config/database');
    (prisma.order.findMany as jest.Mock).mockResolvedValue([
      { id: 'abcdef12-3456-7890-abcd-ef1234567890', phoneNumber: '221770000000', total: 1500, status: 'PENDING', paymentMethod: 'COD', address: 'Dakar', createdAt: new Date(), items: [] },
    ]);
    const result = await findOrderByIdPrefix('abcdef123456');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('abcdef12-3456-7890-abcd-ef1234567890');
  });

  it('returns null on ambiguous prefix (2+ matches)', async () => {
    const { prisma } = require('../src/config/database');
    (prisma.order.findMany as jest.Mock).mockResolvedValue([
      { id: 'abcdef12-0000-0000-0000-000000000001', phoneNumber: '221770000000', total: 1500, status: 'PENDING', paymentMethod: 'COD', address: 'Dakar', createdAt: new Date(), items: [] },
      { id: 'abcdef12-0000-0000-0000-000000000002', phoneNumber: '221770000000', total: 2000, status: 'PENDING', paymentMethod: 'COD', address: 'Dakar', createdAt: new Date(), items: [] },
    ]);
    const result = await findOrderByIdPrefix('abcdef123456');
    expect(result).toBeNull();
  });
});