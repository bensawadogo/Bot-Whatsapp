/**
 * Tests — API REST commandes (mock du service, pas de PostgreSQL requis).
 */
import express from 'express';
import request from 'supertest';

import * as orderService from '../src/modules/orders/order.service';
import { OrderStatus, PaymentMethod, type Order } from '../src/modules/orders/order.types';
import { ordersRouter } from '../src/routes/api/orders.routes';

jest.mock('../src/modules/orders/order.service', () => ({
  listOrders: jest.fn(),
  getOrderById: jest.fn(),
}));

const app = express();
app.use('/api', ordersRouter);

const sampleOrder: Order = {
  id: 'order-abc-123',
  phoneNumber: '221771234567',
  items: [{ productId: 'prod-1', quantity: 2, unitPrice: 1500 }],
  total: 3000,
  status: OrderStatus.CONFIRMED,
  paymentMethod: PaymentMethod.COD,
  address: 'Médina, Dakar',
  createdAt: new Date('2026-09-11T10:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/orders', () => {
  it('retourne la liste paginée avec totaux formatés', async () => {
    (orderService.listOrders as jest.Mock).mockResolvedValue({
      orders: [sampleOrder],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    const res = await request(app).get('/api/orders').expect(200);

    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].totalFormatted).toBe('3 000 FCFA');
    expect(res.body.orders[0].items[0].lineTotalFormatted).toBe('3 000 FCFA');
    expect(res.body.pagination.total).toBe(1);
    expect(orderService.listOrders).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 20 }));
  });

  it('propage les filtres status et phone', async () => {
    (orderService.listOrders as jest.Mock).mockResolvedValue({
      orders: [],
      total: 0,
      page: 2,
      limit: 10,
      totalPages: 0,
    });
    await request(app).get('/api/orders?status=confirmed&phone=221771234567&page=2&limit=10').expect(200);
    expect(orderService.listOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        status: OrderStatus.CONFIRMED,
        phoneNumber: '221771234567',
        page: 2,
        limit: 10,
      }),
    );
  });

  it('rejette un statut inconnu (400)', async () => {
    await request(app).get('/api/orders?status=FOO').expect(400);
    expect(orderService.listOrders).not.toHaveBeenCalled();
  });

  it('rejette une pagination hors bornes (400)', async () => {
    await request(app).get('/api/orders?limit=200').expect(400);
    expect(orderService.listOrders).not.toHaveBeenCalled();
  });
});

describe('GET /api/orders/:id', () => {
  it('retourne le détail de la commande', async () => {
    (orderService.getOrderById as jest.Mock).mockResolvedValue(sampleOrder);
    const res = await request(app).get('/api/orders/order-abc-123').expect(200);
    expect(res.body.order.id).toBe('order-abc-123');
    expect(res.body.order.totalFormatted).toBe('3 000 FCFA');
  });

  it('404 si commande introuvable', async () => {
    (orderService.getOrderById as jest.Mock).mockResolvedValue(null);
    await request(app).get('/api/orders/nope').expect(404);
  });
});