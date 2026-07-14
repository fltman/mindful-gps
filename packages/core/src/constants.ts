/**
 * Konstanterna ur CONTRACT.md §3.1, MINDFUL ur §2.1 och skönhetstabellerna ur §5.2.
 *
 * ⛔ FRUSNA. De ⚠️-markerade är HYPOTESER som sätts av mätning i `bench/` (§7),
 *    aldrig av magkänsla på en biltur. Ändrar du en utan att köra benchmarken vet du
 *    inte om rutterna blev bättre — bara att de blev annorlunda.
 */

import type { RoadClass, RoadPreference, Surface } from './types.js';

// ─── §3.1 Nyhetsminnet ──────────────────────────────────────────────────────

export const H3_RES               = 11;      // cellbredd 49,6 m (flat-to-flat!)
export const H3_SHARD_RES         = 6;       // ~36 km. Ladda bara relevanta shards.
export const H3_SPREAD_RES        = 7;       // ~5 km. Max 1 ankarsegment per cell.
export const H3_DEDUP_RES         = 9;       // Jaccard-dedup av kandidatrutter.
export const H3_SAMPLE_PRIOR_RES  = 8;       // ~1,2 km. Samplingsprior.

export const DENSIFY_M            = 15;      // vid SKRIVNING (se §3.4)
export const SAMPLE_M             = 25;      // vid SCORING. ≈ halva medelkordan (39,3 m)
                                             //   → Nyquist. Ger ~2 sampel per cell.
export const MAX_GAP_M            = 200;     // densifiera ALDRIG över ett större hål
export const MIN_ACCURACY_M       = 30;      // sämre fixar → råspår, men INTE till cellerna
export const MIN_FIX_INTERVAL_MS  = 1000;
export const MIN_FIX_DISTANCE_M   = 10;
export const BEARING_MIN_SPEED_MS = 5;       // under 5 m/s är GPS-bäring rent brus

export const EPOCH_DAY0           = Date.UTC(2020, 0, 1);
export const TAU_DAYS             = 500;     // recency-decay. ⚠️ KALIBRERAS (§7)
export const VISIT_SATURATION     = 0.7;     // 1 - exp(-0.7·visits)
export const NEIGHBOR_SOFTNESS    = 0.35;    // ⚠️ KALIBRERAS (§7)
export const SEGMENT_LENGTH_M     = 400;     // vägsegmentering vid ingest
export const NOVELTY_ANCHOR_MIN   = 0.60;    // ⚠️ KALIBRERAS (§7)

/**
 * Absolut tak för svängtäthet (CONTRACT §5.3). Över detta är rutten stadsgytter, hur
 * svängig baslinjen än råkade vara.
 *
 * Exporterad i stället för inskriven som en litteral i `isNatural`, därför att planeraren
 * normerar MOT den i de lägen som saknar baslinje: en slinga hem till sig själv och ett
 * ben i upptäcktsläget har ingen "raka vägen" att jämföras med. Två `4.0` i två filer
 * hade varit två sanningar som glider isär.
 */
export const TURNS_PER_KM_MAX     = 4.0;

/**
 * Meter unik väg per besökt res-11-cell. Omvandlar cellräkningen till "ditt nät".
 *
 * Härlett ur storlekstabellen i CONTRACT §3.5, som är självkonsistent över alla tre
 * raderna: 500 km → 18 000 celler, 5 000 → 178 000, 20 000 → 713 000. Kvoten är 28 m
 * per cell, och den ligger under res-11:s medelkorda (39,3 m) just för att den redan
 * innehåller GPS-brusets sidospill — celler du snuddade vid men inte körde igenom.
 *
 * ⛔ Detta tal får ALDRIG komma ur odometern. Kör du samma 40 km till jobbet
 *    200 gånger ska nätet stå still. Det är hela produkten.
 */
export const METERS_PER_CELL      = 28;

// ─── §2.1 Den enda RoadPreference vi använder i v1 ──────────────────────────

/** Frusen. */
export const MINDFUL: RoadPreference = {
  motorway: 0.05,        // MJUK. Valhalla returnerar alltid en rutt, men kan
  trunk: 0.20,           // smyga in 2 km E4 när den måste — och då SÄGER vi det.
  track: 0.35,
  livingStreet: 0.40,
  ferry: 0.70,
  tolls: 0.30,
  maxSpeedKph: 80,
  maneuverPenaltyS: 30,
};

/**
 * ⛔ Rör ALDRIG Valhallas `shortest: true`. Den slår ut alla andra kostnader,
 *    inklusive våra preferenser. De tar ut varandra.
 */

// ─── §5.2 Skönhet ───────────────────────────────────────────────────────────

export const CLASS_BEAUTY: Record<RoadClass, number> = {
  motorway: 0.00, trunk: 0.10, primary: 0.30, secondary: 0.55,
  residential: 0.60, living_street: 0.70, track: 0.75,
  service_other: 0.35, tertiary: 0.80, unclassified: 0.90,
};

export const SURFACE_BEAUTY: Record<Surface, number> = {
  paved: 0.50, gravel: 0.90, dirt: 0.75, unknown: 0.50,
};
// grus är vackert. lera är det inte.
