/**
 * Tests — compression d'images produits (< 100 Ko, réalités 2G/3G).
 * Les images d'entrée sont générées par sharp (aucun fixture binaire).
 */
import sharp from 'sharp';

import { compressProductImage } from '../src/shared/images';

/** JPEG "bruité" (rects SVG colorés) pour forcer un poids > 100 Ko en entrée. */
async function makeNoisyJpeg(): Promise<Buffer> {
  const rects = Array.from(
    { length: 400 },
    (_, i) =>
      `<rect x="${(i * 37) % 1600}" y="${(i * 53) % 1200}" width="30" height="30" fill="rgb(${i % 256},${(i * 7) % 256},${(i * 13) % 256})"/>`,
  ).join('');
  const svg = Buffer.from(`<svg width="1600" height="1200">${rects}</svg>`);
  return sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .composite([{ input: svg }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe('compressProductImage (cible < 100 Ko — 2G/3G)', () => {
  it('compresse une grande image sous la cible de 100 Ko', async () => {
    const input = await makeNoisyJpeg();
    const out = await compressProductImage(input);

    expect(out.sizeKb).toBeLessThanOrEqual(100);
    expect(out.buffer.byteLength).toBeLessThan(input.byteLength);
    expect(out.width).toBeLessThanOrEqual(1024);
    expect(out.height).toBeLessThanOrEqual(1024);
  }, 15000);

  it('n\u2019agrandit pas une petite image (withoutEnlargement)', async () => {
    const small = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const out = await compressProductImage(small);

    expect(out.width).toBeLessThanOrEqual(300);
    expect(out.height).toBeLessThanOrEqual(200);
    expect(out.buffer.byteLength).toBeLessThanOrEqual(100 * 1024);
  }, 15000);

  it('garantit la sortie même pour une image énorme (qualité plancher 40)', async () => {
    const input = await makeNoisyJpeg();
    const out = await compressProductImage(input);

    expect(out.quality).toBeGreaterThanOrEqual(40);
    expect(out.quality).toBeLessThanOrEqual(80);
  }, 15000);
});