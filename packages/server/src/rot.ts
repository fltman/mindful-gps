/**
 * Repo-roten, oavsett var processen startades.
 *
 * ⚠️ `npm run dev -w @mindful/server` sätter arbetskatalogen till `packages/server`, medan
 *    `npx tsx packages/server/src/...` körs från roten. En relativ sökväg till
 *    OSM-extrakten fungerade därför i seed-skriptet och dog i servern — men bara vid en
 *    cache-miss, alltså bara när någon planerade en tur till en ny del av landet, alltså
 *    aldrig i utveckling och alltid för användaren.
 *
 *    Sökvägar till filer på disk får inte bero på vem som startade processen.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** .../packages/server/src → .../  */
export const ROT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** En sökväg räknad från repo-roten. */
export const frånRoten = (...delar: string[]): string => resolve(ROT, ...delar);
