import { formatPrice, formatTimestamp } from '../src/shared/format';

describe('formatPrice', () => {
  it('formate les milliers avec des espaces', () => {
    expect(formatPrice(1500)).toBe('1 500 FCFA');
  });

  it('formate les petites valeurs sans espace', () => {
    expect(formatPrice(50)).toBe('50 FCFA');
  });

  it("gère les grandes valeurs (1 million)", () => {
    expect(formatPrice(1_000_000)).toBe('1 000 000 FCFA');
  });

  it("arrondit les valeurs décimales (anti-fraude affichage)", () => {
    expect(formatPrice(1499.6)).toBe('1 500 FCFA');
  });
});

describe('formatTimestamp', () => {
  it('formate un timestamp en JJ/MM HH:mm', () => {
    // 2026-09-11 14:32:00 UTC+0 (heure locale du runner)
    const date = new Date(2026, 8, 11, 14, 32, 0);
    expect(formatTimestamp(date)).toBe('11/09 14:32');
  });
});