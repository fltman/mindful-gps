/**
 * Att välja rutt, från "Vart?" till "Kör".
 *
 * Två skärmar och ett anrop. Flödet äger tre saker som ingen annan får äga:
 *
 *  1. CELLERNA. Minnet är klientens, och det är klienten som plockar ut de celler som
 *     ligger i sökrymden och skickar dem med. Servern har inget minne (`routes/plan.ts`).
 *
 *  2. ORDNINGEN. Servern svarar med förslag OCH baslinje; vi lägger baslinjen sist. Den
 *     ska finnas kvar att jämföra med, men den är inte det vi föreslår.
 *
 *  3. KARTAN. Det valda kortet ritas direkt, i två färger. Kortbytet och kartbytet är
 *     samma händelse — därför ligger `setRoute` här och inte i skärmen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { decode6, todayDay, type LngLat } from '@mindful/core';

import { kartan, minnet, siktaPosition, slutaSikta, useApp } from '../app/state.js';
import type { RecordMode } from '../sense/index.js';

import { CandidatesScreen } from './CandidatesScreen.js';
import { PlanSheet, type Val } from './PlanSheet.js';
import { plan, planCeller, sökradieAB, sökradieTid, type PlanRoute } from './api.js';

/** Vilken tur det blev. Råspåret ska veta vad det var för sorts körning (CONTRACT §3.5). */
const SPÅRLÄGE: Record<Val['mode'], RecordMode> = {
  ab: 'nav_ab',
  loop: 'nav_loop',
  explore: 'explore',
};

export function PlanFlow() {
  const fix = useApp((s) => s.fix);
  const stängPlan = useApp((s) => s.stängPlan);
  const körPlanerad = useApp((s) => s.körPlanerad);

  const [rutter, sättRutter] = useState<readonly PlanRoute[] | null>(null);
  const [vald, sättVald] = useState(0);
  const [läge, sättLäge] = useState<Val['mode']>('ab');
  /** "Kalmar". Det föraren skrev in, inte en koordinat. Följer med ut i körvyn. */
  const [målnamn, sättMålnamn] = useState<string | null>(null);
  const [laddar, sättLaddar] = useState(false);
  const [fel, sättFel] = useState<string | null>(null);

  const pågående = useRef<AbortController | null>(null);

  const från: LngLat | null = fix ? [fix.lon, fix.lat] : null;

  // "Vart?" börjar med "var är jag". GPS:en är släckt på hemskärmen; vi tänder den, tar
  // emot en position, och släcker den igen.
  useEffect(() => {
    siktaPosition();
    return slutaSikta;
  }, []);

  // Rutten på kartan följer det valda kortet. Den ritas i @mindful/core:s nyhet — samma
  // matte planeraren optimerade mot, så bilden och siffran kan aldrig säga olika saker.
  useEffect(() => {
    const karta = kartan();
    const minne = minnet();
    const k = rutter?.[vald];
    if (!karta || !minne || !k) return;

    karta.setRoute(k.route, minne.visited, todayDay());

    const form = decode6(k.route.geometry);
    if (form.length > 1) karta.fitBounds(form, 64);
  }, [rutter, vald]);

  /*
   * Vid avmontering avbryts bara anropet. Rutten på kartan rörs INTE här: den vanligaste
   * anledningen till att flödet avmonteras är att användaren tryckte "Kör", och då ska
   * rutten ligga kvar hela turen. Den som väljer bort en rutt (Tillbaka, eller "Vart?"-
   * arket) släcker den själv — se `stängPlan` och `glömRutt`.
   */
  useEffect(() => () => pågående.current?.abort(), []);

  const glömRutt = useCallback(() => {
    const karta = kartan();
    const minne = minnet();
    if (karta && minne) karta.setRoute(null, minne.visited, todayDay());
  }, []);

  const planera = useCallback((val: Val) => {
    const minne = minnet();
    if (!minne || !fix) return;

    const start: LngLat = [fix.lon, fix.lat];
    const mål = val.to?.at;

    pågående.current?.abort();
    const styrning = new AbortController();
    pågående.current = styrning;

    sättLaddar(true);
    sättFel(null);
    sättLäge(val.mode);
    // I slingan och utsvepet är målet hemmet — den punkt vi står i. Inget att vara framme *i*.
    sättMålnamn(val.mode === 'ab' ? (val.to?.namn ?? null) : null);

    // Sökrymden: ellipsen i (a), räckvidden inom tidsbudgeten i (b) och (c). Bara cellerna
    // därinne skickas — resten av minnet ligger i en annan del av landet.
    const punkter: LngLat[] = mål ? [start, mål] : [start];
    const radie = val.mode === 'ab' && mål
      ? sökradieAB(start, mål, val.epsilon)
      : sökradieTid(val.minutes * 60);

    void (async () => {
      try {
        const cells = await planCeller(minne.store, punkter, radie);

        const svar = await plan({
          mode: val.mode,
          from: start,
          // I utsvepet är `to` HEMMET — punkten kopplet mäts mot. Vi står i den.
          to: val.mode === 'ab' ? mål : start,
          epsilon: val.epsilon,
          minutes: val.minutes,
          headingDeg: val.headingDeg,
          cells,
        }, styrning.signal);

        sättRutter(ordna(svar));
        sättVald(0);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        sättFel(e instanceof Error ? e.message : 'Planeringen gick inte igenom.');
      } finally {
        if (!styrning.signal.aborted) sättLaddar(false);
      }
    })();
  }, [fix]);

  if (rutter) {
    return (
      <CandidatesScreen
        rutter={rutter}
        vald={vald}
        onVälj={sättVald}
        onKör={() => {
          const k = rutter[vald];
          if (k) void körPlanerad(k.route, k.through, SPÅRLÄGE[läge], målnamn);
        }}
        onTillbaka={() => {
          glömRutt();
          sättRutter(null);
        }}
      />
    );
  }

  return (
    <PlanSheet
      från={från}
      laddar={laddar}
      fel={fel}
      onPlanera={planera}
      onRensaFel={() => sättFel(null)}
      onStäng={stängPlan}
    />
  );
}

/**
 * Förslagen först, bäst först — baslinjen sist.
 *
 * Baslinjen är inte ett förslag. Den är den väg man ändå hade kört, och den finns med av
 * ett enda skäl: så att man kan se vad man väljer BORT. Låg vi den först hade appen
 * föreslagit motorvägen.
 */
function ordna(svar: readonly PlanRoute[]): PlanRoute[] {
  const förslag = svar.filter((k) => k.kind === 'candidate')
    .slice()
    .sort((a, b) => b.score - a.score);
  const bas = svar.filter((k) => k.kind === 'baseline');
  return [...förslag, ...bas];
}
