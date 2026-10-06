/**
 * Tests — horaires commerçant (logique pure, aucune dépendance au temps réel).
 */
import { config } from '../src/config/env';
import { currentHourInMerchantTz, isOpenAtHour } from '../src/shared/businessHours';

describe('isOpenAtHour (horaires commerçant)', () => {
  it('horaires non configurés → 24/7', () => {
    expect(isOpenAtHour(3, undefined, undefined)).toBe(true);
    expect(isOpenAtHour(23, undefined, undefined)).toBe(true);
  });

  it('ouverture = fermeture → 24/7 explicite', () => {
    expect(isOpenAtHour(3, 8, 8)).toBe(true);
    expect(isOpenAtHour(15, 8, 8)).toBe(true);
  });

  it('journée standard 8h → 20h', () => {
    expect(isOpenAtHour(7, 8, 20)).toBe(false);
    expect(isOpenAtHour(8, 8, 20)).toBe(true);
    expect(isOpenAtHour(19, 8, 20)).toBe(true);
    expect(isOpenAtHour(20, 8, 20)).toBe(false); // fermeture à 20h inclusive
  });

  it('plage de nuit 22h → 6h (boutique de quartier)', () => {
    expect(isOpenAtHour(23, 22, 6)).toBe(true);
    expect(isOpenAtHour(5, 22, 6)).toBe(true);
    expect(isOpenAtHour(6, 22, 6)).toBe(false);
    expect(isOpenAtHour(12, 22, 6)).toBe(false);
    expect(isOpenAtHour(21, 22, 6)).toBe(false);
  });
});

describe('currentHourInMerchantTz (timezone du commerçant)', () => {
  it('est cohérent avec Intl pour la timezone configurée', () => {
    const date = new Date('2026-09-11T22:00:00Z');
    const expected = Number(
      new Intl.DateTimeFormat('fr-FR', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: config.merchant.timezone,
      })
        .format(date)
        .replace(/[^\d]/g, ''),
    );
    expect(currentHourInMerchantTz(date)).toBe(expected);
  });

  it('retourne une heure valide entre 0 et 23 (h23 : minuit = 0, jamais 24)', () => {
    for (let h = 0; h < 24; h++) {
      const date = new Date(Date.UTC(2026, 8, 11, h, 30));
      const result = currentHourInMerchantTz(date);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(23);
    }
  });
});