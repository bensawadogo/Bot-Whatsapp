/**
 * AfriBot — formatage des valeurs (fonctions pures, testables unitairement).
 */

/** Formate un prix entier en "1 500 FCFA" (espaces milliers, devise XOF). */
export function formatPrice(price: number): string {
  return `${String(Math.round(price)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

/** Formate un horodatage au format JJ/MM HH:mm (jour/mois). */
export function formatTimestamp(ts: number | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}