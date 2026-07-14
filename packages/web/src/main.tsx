/**
 * Ingången.
 *
 * Motorn startas FÖRE React. Att öppna minnet, läsa in nätet och starta synken är
 * ingenting ett komponentträd ska äga — och kartan ska ha sina trådar i samma ögonblick
 * den finns. `boot()` är idempotent; `Router` monterar sig ovanpå den när den är klar.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Skärmarnas utseende. Modulerna importerar ingen CSS själva — den hör hemma i skalet.
import './ui/tokens.css';
import './ui/ui.css';
import './plan/plan.css';

import { Router } from './app/router.js';
import { useApp } from './app/state.js';

const rot = document.getElementById('root');
if (!rot) throw new Error('#root saknas i index.html');

void useApp.getState().boot();

createRoot(rot).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
