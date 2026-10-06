/**
 * AfriBot — envoi de messages sortants via Evolution API (REST).
 *
 * Tous les messages partent par la Cloud API Meta officielle, relayée par
 * Evolution API (endpoint REST + header apikey). Aucun canal non officiel.
 * Retry automatique : 3 tentatives avec backoff exponentiel (500ms/1s/2s).
 *
 * Formats de payload = Evolution API v2 (à valider contre l'instance réelle,
 * voir TODO.md Phase 0). Les boutons "reply" WhatsApp renvoient leur
 * displayText en message texte : le label doit donc être unique et routable.
 */
import axios, { type AxiosInstance } from "axios";

import { config } from "../config/env";
import { logger } from "../config/logger";
import { history } from "./history";
import { checkMessageCompliance, checkWindowCompliance, isInternalRecipient, logConversation, enforceOptIn } from "./meta.compliance";
import { isRegisteredLivreur } from "../modules/delivery/delivery.service";

// ---------------------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------------------

export interface ListItem {
  title: string;
  description?: string;
  productId: string;
}

export interface Button {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// DTOs Evolution API v2 (formats de payload exacts attendus par l'endpoint)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Client HTTP Evolution API avec retry
// ---------------------------------------------------------------------------

export class MessageSender {
  private readonly http: AxiosInstance;
  private static readonly MAX_RETRIES = 3;

  constructor() {
    this.http = axios.create({
      baseURL: config.evolution.apiUrl,
      headers: { apikey: config.evolution.apiKey, "Content-Type": "application/json" },
      timeout: 10_000,
    });
  }

  /**
   * POST avec retry (3 tentatives, backoff exponentiel).
   * Ne retry QUE sur : 5xx (erreur serveur), 429 (rate limit), timeout réseau.
   * Lance une erreur après épuisement des tentatives.
   */
  private async postWithRetry<T>(path: string, payload: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MessageSender.MAX_RETRIES; attempt++) {
      try {
        const response = await this.http.post<T>(path, payload);
        return response.data;
      } catch (err) {
        lastError = err;
        const isRetryable = axios.isAxiosError(err) && (
          (err.response?.status !== undefined && err.response.status >= 500) ||
          err.response?.status === 429 ||
          err.code === "ECONNABORTED" ||
          err.code === "ETIMEDOUT"
        );
        if (!isRetryable || attempt >= MessageSender.MAX_RETRIES) {
          throw err;
        }
        logger.warn(`Evolution API ${path} — tentative ${attempt}/${MessageSender.MAX_RETRIES} échouée (retry)`);
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`Evolution API ${path} : échec après ${MessageSender.MAX_RETRIES} tentatives (${String(lastError)})`);
  }

  /**
   * Enregistre un message sortant dans l'historique (fire-and-forget).
   * Un échec d'historique ne doit JAMAIS casser l'envoi WhatsApp.
   */
  private async record(to: string, text: string, type: string): Promise<void> {
    try {
      await history.append(to, { fromMe: true, text: text.slice(0, 500), type });
    } catch (err) {
      logger.warn(`Historique sortant non enregistré pour ${to} : ${String(err)}`);
    }
    void logConversation({ phone: to, fromMe: true, text, type });
  }

  /**
   * Garde-fous Meta avant CHAQUE envoi (MODULE 5.1).
   *
   * Deux catégories de destinataires (règle Meta : la fenêtre de 24 h et
   * l'opt-in concernent les CLIENTS, pas l'équipe du commerçant) :
   *  - interne (numéro du commerçant) ou livreur enregistré → envoi autorisé
   *    sans fenêtre (relation professionnelle, le livreur a été ajouté par le
   *    commerçant et a répondu "OUI").
   *  - client → contrôle du contenu (anti-promotion / anti-contenu sensible)
   *    puis fenêtre de service :
   *      IN_WINDOW  → messages libres (gratuits)
   *      OUT_WINDOW → SEULS les templates pré-approuvés sont autorisés
   *
   * @param kind 'template' = message pré-approuvé par Meta (bypass total).
   * @returns true si l'envoi est autorisé.
   */
  private async isSendAllowed(to: string, text: string, kind: "service" | "template"): Promise<boolean> {
    if (kind === "template") return true;

    if (isInternalRecipient(to) || (await isRegisteredLivreur(to))) return true;

    const optIn = await enforceOptIn(to);
    if (!optIn) {
      logger.warn(`Message bloqué — pas d'opt-in de ${to}`);
      return false;
    }

    const content = checkMessageCompliance(text, kind);
    if (!content.valid) {
      logger.warn(`Message non conforme bloqué (${to}) : ${content.reason ?? "contenu refusé"}`);
      return false;
    }

    const window = await checkWindowCompliance(to);
    if (window.status === "OUT_WINDOW") {
      logger.warn(
        `Message hors fenêtre bloqué — utiliser un template (${to}, dernier message client : ${
          window.lastInboundAt?.toISOString() ?? "aucun"
        })`,
      );
      return false;
    }
    return true;
  }

  async sendText(to: string, text: string): Promise<void> {
    if (!(await this.isSendAllowed(to, text, "service"))) return;
    await this.postWithRetry(`/message/sendText/${config.evolution.instanceName}`, {
      number: to,
      text,
    });
    void this.record(to, text, "text");
  }

  async sendTextTemplate(to: string, text: string): Promise<void> {
    if (!(await this.isSendAllowed(to, text, "template"))) return;
    await this.postWithRetry(`/message/sendText/${config.evolution.instanceName}`, {
      number: to,
      text,
    });
    void this.record(to, text, "template");
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<void> {
    if (!(await this.isSendAllowed(to, caption ?? imageUrl, "service"))) return;
    await this.postWithRetry(`/message/sendMedia/${config.evolution.instanceName}`, {
      number: to,
      mediatype: "image",
      media: imageUrl,
      ...(caption !== undefined && { caption }),
    });
    void this.record(to, caption ?? imageUrl, "image");
  }

  async sendList(to: string, title: string, items: ListItem[]): Promise<void> {
    if (!(await this.isSendAllowed(to, title, "service"))) return;
    const payload = {
      number: to,
      title,
      description: "Répondez avec le numéro du produit pour voir le détail.",
      buttonText: "Voir",
      footerText: "AfriBot",
      sections: [
        {
          title: "Produits",
          rows: items.map((item) => ({
            rowId: item.productId,
            title: item.title,
            ...(item.description !== undefined && { description: item.description }),
          })),
        },
      ],
    };
    await this.postWithRetry(`/message/sendList/${config.evolution.instanceName}`, payload);
    void this.record(to, `${title} (${items.length} produits)`, "list");
  }

  async sendButtons(to: string, text: string, buttons: Button[]): Promise<void> {
    if (!(await this.isSendAllowed(to, text, "service"))) return;
    const payload = {
      number: to,
      title: "AfriBot",
      message: text,
      footerText: "AfriBot",
      buttons: buttons.map((button) => ({
        buttonText: { displayText: button.label },
        type: "reply",
        displayText: button.label,
      })),
    };
    await this.postWithRetry(`/message/sendButtons/${config.evolution.instanceName}`, payload);
    void this.record(to, text, "buttons");
  }
}

export const messageSender = new MessageSender();