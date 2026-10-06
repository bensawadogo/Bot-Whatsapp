/**
 * AfriBot — horaires du commerçant (réalités africaines : boutique fermée la
 * nuit, pause déjeuner, jour de marché...). Le bot informe le client au lieu
 * d'accepter une commande qui ne serait traitée que le lendemain.
 *
 * Config : MERCHANT_OPEN_HOUR + MERCHANT_CLOSE_HOUR (0-23 / 0-24) et
 * MERCHANT_TIMEZONE (IANA, défaut Africa/Dakar). Non configurés → 24/7.
 */
import { config } from '../config/env';

export interface ShopSchedule {
  openHour?: number | undefined;
  closeHour?: number | undefined;
  timezone?: string | undefined;
  closedDays?: number[] | undefined;
}

/** Logique pure testable : boutique ouverte à l'heure h (locale, 0-23) ? */
export function isOpenAtHour(
  hour: number,
  openHour: number | undefined,
  closeHour: number | undefined,
): boolean {
  // Horaires non configurés → comportement 24/7 (aucun blocage)
  if (openHour === undefined || closeHour === undefined) return true;
  // Ouverture = fermeture → 24/7 explicite
  if (openHour === closeHour) return true;
  // Plage de nuit (ex : 22h → 6h) gérée : ouvert si h >= open OU h < close
  return openHour < closeHour ? hour >= openHour && hour < closeHour : hour >= openHour || hour < closeHour;
}

/** Heure courante (0-23) dans la timezone indiquée (h23 : minuit = 0). */
export function currentHourInMerchantTz(
  now: Date = new Date(),
  timezone: string = config.merchant.timezone,
): number {
  try {
    const formatter = new Intl.DateTimeFormat('fr-FR', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: timezone,
    });
    const hour = Number(formatter.format(now).replace(/[^\d]/g, ''));
    return Number.isNaN(hour) ? now.getHours() : hour;
  } catch {
    // Timezone invalide → heure locale du serveur (fail-safe, pas de crash)
    return now.getHours();
  }
}

/** Jour courant (0 = dimanche) dans la timezone indiquée. */
export function currentWeekdayInMerchantTz(
  now: Date = new Date(),
  timezone: string = config.merchant.timezone,
): number {
  try {
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: timezone,
    })
      .format(now)
      .slice(0, 3)
      .toLowerCase();
    return { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[weekday] ?? now.getDay();
  } catch {
    return now.getDay();
  }
}

/** Boutique ouverte maintenant ? Utilisé par le ConversationRouter (état IDLE). */
export function isShopOpen(
  now: Date = new Date(),
  schedule: ShopSchedule = config.merchant,
): boolean {
  const timezone = schedule.timezone ?? config.merchant.timezone;
  const weekday = currentWeekdayInMerchantTz(now, timezone);
  if ((schedule.closedDays ?? []).includes(weekday)) return false;
  return isOpenAtHour(
    currentHourInMerchantTz(now, timezone),
    schedule.openHour,
    schedule.closeHour,
  );
}