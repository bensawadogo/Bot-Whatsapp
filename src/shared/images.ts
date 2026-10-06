/**
 * AfriBot — optimisation d'images produits (réalités africaines : 2G/3G).
 *
 * Objectif : < 100 Ko par image (docs/TODO.md Phase 1) pour un envoi fiable
 * en zone à faible bande passante. Pipeline sharp :
 *   1. rotation auto selon EXIF (photos prises au téléphone, orientées par capteur)
 *   2. resize max 1024 px (fit "inside" — jamais d'agrandissement)
 *   3. JPEG qualité dégressive (80 → 40, mozjpeg) jusqu'à passer sous la cible
 */
import sharp from 'sharp';

import { logger } from '../config/logger';

/** Cible de poids par image (2G/3G — WhatsApp envoie mal au-delà). */
const TARGET_KB = 100;
/** Dimension max : suffisant pour un visuel produit sur mobile. */
const MAX_DIMENSION = 1024;
/** Qualité plancher : en dessous, les artefacts dégradent la vente. */
const MIN_QUALITY = 40;

export interface CompressedImage {
  buffer: Buffer;
  /** Poids final en Ko (1 décimale). */
  sizeKb: number;
  /** Qualité JPEG finale retenue. */
  quality: number;
  width: number;
  height: number;
}

/**
 * Compresse une image produit en JPEG < 100 Ko.
 * Lève une erreur si l'entrée n'est pas une image décodable par sharp.
 */
export async function compressProductImage(input: Buffer): Promise<CompressedImage> {
  let quality = 80;
  let buffer: Buffer;
  let width = 0;
  let height = 0;

  // Boule dégressive : 80 → 70 → ... → 40 (garantie de sortie : qualité plancher)
  for (;;) {
    const result = await sharp(input)
      .rotate() // respecte l'orientation EXIF
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true, progressive: true })
      .toBuffer({ resolveWithObject: true });
    buffer = result.data;
    width = result.info.width;
    height = result.info.height;
    if (buffer.byteLength <= TARGET_KB * 1024 || quality <= MIN_QUALITY) break;
    quality = Math.max(MIN_QUALITY, quality - 10);
  }

  const sizeKb = Math.round((buffer.byteLength / 1024) * 10) / 10;
  if (sizeKb > TARGET_KB) {
    logger.warn(
      `Image compressée au-delà de la cible : ${sizeKb} Ko (qualité plancher ${quality}) — à revoir (photo ?)`,
    );
  }

  return { buffer, sizeKb, quality, width, height };
}