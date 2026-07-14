/**
 * Enhetsidentitet.
 *
 * Ingen inloggning i v1. Klienten genererar ett uuid vid första starten, lagrar det i
 * IndexedDB ('meta' → 'deviceId') och skickar det som X-Device-Id. Kontona kommer i
 * Fas 3; `user_id` finns redan i schemat, nullbart, så det blir en UPDATE och inte en
 * migrering.
 */

import type { FastifyRequest } from 'fastify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ett fel klienten kan rätta till själv → 400, aldrig 500. */
export class BadRequest extends Error {}

/** Enhetens uuid, normaliserat till gemener. Kastar BadRequest om headern saknas. */
export function deviceIdOf(req: FastifyRequest): string {
  const raw = req.headers['x-device-id'];
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new BadRequest('X-Device-Id måste vara ett uuid');
  }
  return id.toLowerCase();
}
