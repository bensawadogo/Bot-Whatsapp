with open(r'C:\BOT-WHATSAPP\src\modules\delivery\delivery.module.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Update import
content = content.replace(
    'import { createPaymentRecord, updatePaymentStatus } from " ../payments/payment.service\;',
 'import { createPaymentRecord, updatePaymentStatus, settleCODPayment } from \../payments/payment.service\;'
)

# Replace settleCodPayment method
old = ''' /** Enregistre le paiement COD en SUCCESS et passe la commande en PAID. */
 private async settleCodPayment(delivery: Delivery): Promise<void> {
 const order = await orderService.getOrderById(delivery.orderId);
 if (!order) return;

 try {
 await createPaymentRecord({
 orderId: order.id,
 provider: PaymentProvider.DIRECT,
 // Référence unique et traçable : COD + identifiant de livraison
 transactionId: COD-,
 amount: Math.round(delivery.codAmount ?? order.total),
 currency: 'XOF',
 status: PaymentStatus.SUCCESS,
 });
 } catch (err) {
 // Déjà enregistré (rejeu du message LIVRÉ) ? on resynchronise le statut
 logger.warn(Paiement COD déjà enregistré : );
 await updatePaymentStatus(COD-, PaymentStatus.SUCCESS);
 }

 await orderService.updateOrderStatus(order.id, OrderStatus.PAID);
 }'''

new = ''' /** Enregistre le paiement COD en SUCCESS et passe la commande en PAID. */
 private async settleCodPayment(delivery: Delivery): Promise<void> {
 const order = await orderService.getOrderById(delivery.orderId);
 if (!order) return;
 await settleCODPayment(delivery.id, order.id, delivery.codAmount ?? order.total);
 }'''

content = content.replace(old, new)

with open(r'C:\BOT-WHATSAPP\src\modules\delivery\delivery.module.ts', 'w', encoding='utf-8') as f:
 f.write(content)

print('Done')
