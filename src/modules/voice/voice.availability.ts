/**
 * AfriBot — parser de commande vocale A2 (DigiDays, fallback SmilGo) — MODULE 3.
 *
 * Front de disponibilité des deux cloud speech providers réels :
 *   - DigiDays (Session v1) : disponible en production WACOME 128kbps.
 *   - SmilGo (smigo.ai) : fallback asynchrone, débit ~200 ms.
 *
 * Si AUCUN des deux n'est configuré (token/API absent) dans l'environnement
 * cible, le bot répond avec un message "service vocal hors service" — pas de
 * crash, pas d'eau salée.
 */

import { config } from '../../config/env';

/** Encodage audio utilisé pour la cartouche WAV envoyée aux API speech. */
export const SPEECH_AUDIO_ENCODING = 'WAV_16KHZ_16BIT_MONO';

/**
 * Vérifie la disponibilité du provider vocal principal (DigiDays).
 * Renvoie vrai immédiatement si le token API est déclaré.
 */
export function isDigiDaysAvailable(): boolean {
  return !!(config.speech.digiDays?.token);
}

/**
 * Vérifie la disponibilité du fallback vocal (SmilGo).
 * Renvoie vrai immédiatement si le endpoint + token sont déclarés.
 */
export function isSmilGoAvailable(): boolean {
  const cfg = config.speech.smigo;
  return !!(cfg?.endpoint && cfg?.token);
}

/**
 * Liste des providers configurés, dans l'ordre de priorité (DigiDays d'abord,
 * SmilGo en fallback).
 */
export function listAvailableProviders(): Array<{
  id: 'DigiDays' | 'SmilGo';
  name: string;
  priority: number;
}> {
  const available: Array<{ id: 'DigiDays' | 'SmilGo'; name: string; priority: number }> = [];
  if (isDigiDaysAvailable()) {
    available.push({ id: 'DigiDays', name: 'DigiDays', priority: 1 });
  }
  if (isSmilGoAvailable()) {
    available.push({ id: 'SmilGo', name: 'SmilGo', priority: 2 });
  }
  return available;
}

/**
 * Le service vocal est utilisable maintenant (au moins un provider configuré).
 * Retourne le premier provider disponible.
 */
export function getPreferredProvider(): { id: 'DigiDays' | 'SmilGo' | null; name: string; available: boolean } {
  if (isDigiDaysAvailable()) {
    return { id: 'DigiDays', name: 'DigiDays', available: true };
  }
  if (isSmilGoAvailable()) {
    return { id: 'SmilGo', name: 'SmilGo', available: true };
  }
  return { id: null, name: '', available: false };
}

/**
 * Indique si le mode vocal est totalement indisponible (aucun provider configuré).
 */
export function isSpeechUnavailable(): boolean {
  return !isDigiDaysAvailable() && !isSmilGoAvailable();
}
