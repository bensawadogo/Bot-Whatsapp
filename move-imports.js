const fs = require('fs');
let c = fs.readFileSync('C:\\BOT-WHATSAPP\\src\\shared\\webhook.controller.ts', 'utf8');
c = c.replace("import { PaymentModule } from '../modules/payments/payment.module';\r\nimport type { CinetPayWebhook, FedaPayWebhook } from '../modules/payments/payment.types';\r\n", '');
c = c.replace("import { handleCTWAWebhook } from '../modules/campaigns/campaign.service';\r\n", "import { handleCTWAWebhook } from '../modules/campaigns/campaign.service';\r\nimport { PaymentModule } from '../modules/payments/payment.module';\r\nimport type { CinetPayWebhook, FedaPayWebhook } from '../modules/payments/payment.types';\r\n");
fs.writeFileSync('C:\\BOT-WHATSAPP\\src\\shared\\webhook.controller.ts', c, 'utf8');
console.log('Moved imports to top');
