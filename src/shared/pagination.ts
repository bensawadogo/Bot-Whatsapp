/**
 * AfriBot — lecture partagée des paramètres de pagination (?page, ?limit).
 *
 * Utilisée par toutes les routes GET de l'API REST du dashboard. Bornes :
 * page >= 1 (max 1000), limit entre 1 et 100 (défaut 20).
 */
import type { Request } from 'express';

/** Retourne { page, limit } validés, ou null si les paramètres sont invalides. */
export function parsePagination(
  query: Request['query'],
): { page: number; limit: number } | null {
  const page = Math.floor(Number(query.page ?? 1));
  const limit = Math.floor(Number(query.limit ?? 20));
  if (!Number.isInteger(page) || page < 1 || page > 1000) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return null;
  return { page, limit };
}