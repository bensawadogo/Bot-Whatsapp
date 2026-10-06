jest.mock('../src/config/database', () => ({
  prisma: { order: { findFirst: jest.fn() } },
}));

import { findOrderByIdPrefix } from '../src/modules/orders/order.service';

describe('findOrderByIdPrefix', () => {
  it('returns null for short prefix', async () => {
    const result = await findOrderByIdPrefix('ab');
    expect(result).toBeNull();
  });
});
