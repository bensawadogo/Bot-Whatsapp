/**
 * AfriBot — templates WhatsApp pré-approuvés par Meta (MODULE 5.2).
 *
 * POURQUOI : hors de la fenêtre de service de 24 h, un compte WhatsApp
 * Business ne peut envoyer QUE des templates approuvés (règle Meta 2026).
 * Ces messages sont facturés mais garantissent la délivrabilité — c'est le
 * seul moyen de relancer un client qui ne nous a pas écrit depuis 24 h.
 *
 * Les templates sont en catégorie UTILITY (jamais MARKETING) : service rendu
 * au client (confirmation, paiement, livraison) → coût moindre et pas de
 * risque de blocage pour « spam promotionnel ».
 *
 * SOUMISSION : POST /api/templates/submit (une seule fois en production).
 */

/** Composant d'un template au format Meta Graph API. */
export interface TemplateComponent {
  type: 'BODY' | 'HEADER' | 'FOOTER' | 'BUTTONS';
  text?: string;
  /** Exemples obligatoires pour Meta quand le corps contient des variables. */
  example?: { body_text: string[][] };
  format?: 'TEXT';
}

/** Définition d'un template prêt à soumettre à l'API Meta Graph. */
export interface MessageTemplate {
  /** Nom technique (snake_case, unique par compte WhatsApp Business). */
  name: string;
  language: string;
  /** UTILITY = service rendu au client ; MARKETING = promotion (à éviter). */
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  components: TemplateComponent[];
}

/**
 * Templates AfriBot — délibérément courts (lisible sur 2G) et sans terme
 * promotionnel. Les variables {{1}}, {{2}}... sont remplacées à l'envoi.
 */
export const TEMPLATES: Record<string, MessageTemplate> = {
  ORDER_CONFIRMATION: {
    name: 'order_confirmation_afribot',
    language: 'fr',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Votre commande {{1}} a été confirmée. Montant : {{2}} FCFA. Livraison prévue : {{3}}.',
        example: { body_text: [['#12345', '5000', "aujourd'hui"]] },
      },
    ],
  },

  PAYMENT_REQUEST: {
    name: 'payment_request_afribot',
    language: 'fr',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Paiement en attente pour votre commande {{1}} : {{2}} FCFA. Envoyez au {{3}} puis confirmez avec votre code.',
        example: { body_text: [['#12345', '5000', '+22670000000']] },
      },
    ],
  },

  DELIVERY_UPDATE: {
    name: 'delivery_update_afribot',
    language: 'fr',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Votre commande {{1}} est en route. Votre livreur arrive dans environ {{2}} minutes.',
        example: { body_text: [['#12345', '20']] },
      },
    ],
  },
};

/** Clés des templates disponibles. */
export type TemplateKey = keyof typeof TEMPLATES;

// ---------------------------------------------------------------------------
// Rendu local (hors API Meta — utile pour les tests et les envois de contrôle)
// ---------------------------------------------------------------------------

/**
 * Remplace les variables {{1}}, {{2}}... d'un template par les valeurs
 * fournies. Meta exige des variables STRICTEMENT séquentielles : une valeur
 * manquante laisse le placeholder en place plutôt que de décaler les suivants.
 */
export function renderTemplate(key: TemplateKey, values: string[]): string {
  const template = TEMPLATES[key];
  const body = template.components.find((c) => c.type === 'BODY');
  if (!body?.text) return '';
  return body.text.replace(/\{\{(\d+)\}\}/g, (match, index: string) => {
    const value = values[Number(index) - 1];
    return value ?? match;
  });
}

/** Rendu de ORDER_CONFIRMATION (helper typé). */
export function orderConfirmationBody(orderRef: string, amount: number, when: string): string {
  return renderTemplate('ORDER_CONFIRMATION', [orderRef, String(Math.round(amount)), when]);
}

/** Rendu de PAYMENT_REQUEST (helper typé). */
export function paymentRequestBody(orderRef: string, amount: number, merchantNumber: string): string {
  return renderTemplate('PAYMENT_REQUEST', [orderRef, String(Math.round(amount)), merchantNumber]);
}

/** Rendu de DELIVERY_UPDATE (helper typé). */
export function deliveryUpdateBody(orderRef: string, minutes: number): string {
  return renderTemplate('DELIVERY_UPDATE', [orderRef, String(minutes)]);
}