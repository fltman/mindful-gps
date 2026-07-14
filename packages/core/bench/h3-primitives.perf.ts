/**
 * Var tar mikrosekunderna vägen? Rå h3-js mot vårt lager ovanpå.
 *
 * Kör:  npx tsx packages/core/bench/h3-primitives.perf.ts
 */

import { performance } from 'node:perf_hooks';
import { gridDisk as h3GridDisk, latLngToCell } from 'h3-js';

import { H3_RES } from '../src/constants.js';
import { cell, gridDisk } from '../src/h3util.js';

const N = 200_000;

function ns(label: string, iters: number, fn: () => void): void {
  for (let i = 0; i < iters / 10; i++) fn();
  const t = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const per = (performance.now() - t) * 1e6 / iters;
  console.log(`${label.padEnd(52)} ${per.toFixed(0).padStart(6)} ns`);
}

const lat = 57.7089;
const lon = 11.9746;
const hex = latLngToCell(lat, lon, H3_RES);
const big = BigInt('0x' + hex);

console.log('── Rå h3-js (WASM-gränsen) ─────────────────────────────────────────');
ns('h3-js latLngToCell(lat, lng, 11) → hex', N, () => { latLngToCell(lat, lon, H3_RES); });
ns('h3-js gridDisk(hex, 1) → hex[7]', N / 4, () => { h3GridDisk(hex, 1); });

console.log('\n── Vår konvertering ────────────────────────────────────────────────');
ns('bigint.toString(16)', N, () => { big.toString(16); });
ns("BigInt('0x' + hex)", N, () => { BigInt('0x' + hex); });
ns("7 × BigInt('0x' + hex) (som .map(toBig))", N / 4, () => {
  h3GridDisk(hex, 1).map(h => BigInt('0x' + h));
});

console.log('\n── Vårt lager (h3util) ─────────────────────────────────────────────');
ns('h3util.cell([lon,lat], 11)', N, () => { cell([lon, lat], H3_RES); });
ns('h3util.gridDisk(bigint, 1)', N / 4, () => { gridDisk(big, 1); });

console.log('\n── Budget per 30 km-rutt (1 200 sampel) ────────────────────────────');
const tCell = (() => {
  const t = performance.now();
  for (let i = 0; i < N; i++) cell([lon, lat], H3_RES);
  return (performance.now() - t) * 1e6 / N;
})();
const tDisk = (() => {
  const t = performance.now();
  for (let i = 0; i < N / 4; i++) gridDisk(big, 1);
  return (performance.now() - t) * 1e6 / (N / 4);
})();
console.log(`1 200 × cell()      = ${(tCell * 1200 / 1e6).toFixed(2)} ms`);
console.log(`1 200 × gridDisk()  = ${(tDisk * 1200 / 1e6).toFixed(2)} ms`);
console.log(`summa                 ${((tCell + tDisk) * 1200 / 1e6).toFixed(2)} ms   (budget: 1,00 ms)`);
