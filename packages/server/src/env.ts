/**
 * Ladda `.env` in i `process.env` — robust, oavsett hur processen startades.
 *
 * ⚠️ Detta MÅSTE vara den första importen i `index.ts`. ES-moduler kör sina importer i
 *    ordning, före den importerande modulens kropp, så en side-effect-import här hinner
 *    fylla miljön innan `openrouter.ts` och `rost.ts` läser sina nycklar.
 *
 * Varför inte `--env-file`? Vi hade den i dev-skriptet, och den bet inte: `tsx watch`
 *    startar en arbetsprocess som INTE ärver node-flaggan, så `.env` laddades bara första
 *    gången (via miljöarv) och försvann vid nästa omladdning. Resultatet blev "Uppläsning
 *    är inte påslagen" mitt i en session, utan att någon rört nyckeln. Att ladda filen
 *    explicit i koden kan inte glida isär med hur processen råkar startas.
 *
 * Filen är gitignore:ad och innehåller hemligheter. `process.loadEnvFile` skriver ALDRIG
 * över en variabel som redan finns i miljön — så en shell-satt `OPENROUTER_API_KEY` vinner
 * fortfarande över en rad i filen, precis som förr.
 */

import { existsSync } from 'node:fs';

import { frånRoten } from './rot.js';

const fil = frånRoten('.env');
if (existsSync(fil)) {
  process.loadEnvFile(fil);
}
