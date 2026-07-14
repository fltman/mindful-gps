/**
 * Sevärdheter — det som finns att se längs vägen.
 *
 * ⛔ DE STYR INTE RUTTEN. De ritas på kartan, och där slutar deras makt.
 *
 * ── Varför inte, och hur vi vet ─────────────────────────────────────────────
 *
 * Vi byggde motsatsen först: sevärdheterna som en faktor i ankarrankningen, så att
 * planeraren bland de okända vägbitarna hellre valde den som gick förbi en runsten.
 * `bench/sevardheter.ts` mätte den, och den föll:
 *
 *     pull 0 (av)     395 km   0,154 vikt/km
 *     pull 1,0        412 km   0,151 vikt/km      ← 4,4 % längre, 1,7 % GLESARE
 *
 * Två skäl, och det andra är det viktiga:
 *
 *   1. Ingen hävstång. Åtta through-punkter à 400 m kan inte styra vilka sevärdheter en
 *      14-milsrutt passerar. Det avgörs av vägnätet.
 *
 *   2. De drar ÅT FEL HÅLL. `bench/sevardheter-spridning.ts`: på Växjö → Karlskrona har
 *      BASLINJEN den högsta sevärdhetstätheten av alla kandidater. Det är ingen slump. I
 *      Sverige ligger kyrkorna, runstenarna, fornlämningarna och herrgårdarna längs de
 *      vägar folk alltid har färdats. Att tvinga rutten ut på okänd småväg flyttar den per
 *      definition BORT från dem. Nyhet och sevärdheter är i konflikt, inte i samklang.
 *
 * Att rutta efter sevärdheter är alltså att rutta tillbaka mot den vanliga vägen — precis
 * det appen finns för att slippa. Vi ritar dem i stället, och låter föraren svänga av.
 *
 * `sightScore` och `SightGrid` finns kvar för att bench ska kunna köra om mätningen. Ingen
 * kodväg i appen anropar dem. Gör den det igen: kör bench först.
 *
 * ── Vikterna ────────────────────────────────────────────────────────────────
 *
 * Används numera till att avgöra vilka sevärdheter som ritas när kartan är för trång för
 * alla. En utsiktsplats syns från vägen. Ett museum är en byggnad man måste gå in i.
 */

import { haversine } from './geo.js';
import type { LngLat } from './types.js';

export type SightKind =
  | 'utsikt' | 'vattenfall' | 'runsten' | 'fornlämning' | 'borg' | 'fyr'
  | 'naturreservat' | 'kyrka' | 'museum' | 'sevärdhet' | 'konst' | 'minnesmärke';

/**
 * Hur mycket en sevärdhet är värd att KÖRA FÖRBI. Inte hur intressant den är att besöka.
 *
 * Utsikten och vattenfallet toppar för att de ger dig något medan du kör. Museet ligger
 * lågt av exakt motsatt skäl — det kräver att du kliver ur bilen, och den här appen
 * lägger sig aldrig i om du gör det.
 */
export const SIGHT_WEIGHT: Readonly<Record<SightKind, number>> = {
  utsikt: 1.00,
  vattenfall: 0.95,
  runsten: 0.90,
  borg: 0.85,
  fyr: 0.85,
  // ⚠️ 0,65, inte 0,75, och det är mätt på kartan: `historic=archaeological_site` i Sverige
  //    är till stor del SLAGGVARP — järnålderns slagghögar, hundratals i samma skog, de
  //    flesta namnlösa. Utzoomad blev östra Småland en enda brun klump av dem. En slagghög
  //    är arkeologi, inte en anledning att svänga av. Under TUNG_NOG (0,70) syns de först
  //    när man är i trakten, och där hör de hemma.
  fornlämning: 0.65,
  naturreservat: 0.70,
  kyrka: 0.45,
  sevärdhet: 0.55,
  museum: 0.35,
  minnesmärke: 0.30,
  konst: 0.30,
};

export interface Sight {
  readonly id: number;
  readonly kind: SightKind;
  /** Kan vara tom. En namnlös runsten är fortfarande en runsten. */
  readonly name: string;
  readonly at: LngLat;
}

/**
 * Så långt bort en sevärdhet får ligga från vägen och ändå räknas.
 *
 * 700 m är ungefär så långt man ser över en småländsk åker, och det är inte en slump att
 * talet ligger där: syns den inte från bilen finns den inte för den här appen.
 *
 * ⚠️ KALIBRERAS (§7).
 */
export const SIGHT_RADIUS_M = 700;

/**
 * Hur mycket sevärdhet det finns runt en punkt. 0 → 1.
 *
 * ── Mättnad, inte summa ─────────────────────────────────────────────────────
 *
 * `1 - exp(-Σw)` och inte `Σw`. Skillnaden avgör vad appen tror är vackert:
 *
 *   En kyrkby med kyrka + hembygdsgård + fyra minnesstenar summerar till 2,1.
 *   En enslig utsiktsplats över en sjö summerar till 1,0.
 *
 * Med en rak summa vinner kyrkbyn — och planeraren hade envist kört dig genom varenda
 * samhälle i Småland i stället för ut på höjderna. Mättnaden gör den andra stenen nästan
 * värdelös och den första utsikten dyr: 2,1 → 0,88 mot 1,0 → 0,63. Kyrkbyn vinner
 * fortfarande, men inte med mycket, och den vinner inte över TVÅ utsikter.
 *
 * ── Avståndet ───────────────────────────────────────────────────────────────
 *
 * Linjär avtoning ut till radien. En runsten femtio meter från vägen är inte dubbelt så
 * mycket värd som en tvåhundra meter bort — men den vid radiens kant, som man precis inte
 * ser, ska väga noll, och ingenting däremellan ska hoppa.
 */
export function sightScore(
  at: LngLat, sights: readonly Sight[], radiusM: number = SIGHT_RADIUS_M,
): number {
  let sum = 0;

  for (const s of sights) {
    const d = haversine(at, s.at);
    if (d >= radiusM) continue;
    sum += SIGHT_WEIGHT[s.kind] * (1 - d / radiusM);
  }

  return sum === 0 ? 0 : 1 - Math.exp(-sum);
}

/**
 * Sevärdheterna i ett rutnät, så `sightScore` kan frågas tiotusentals gånger.
 *
 * Ellipsen Växjö → Kalmar är ~33 000 km² och rymmer några tusen sevärdheter. Ankarna i
 * samma ellips är tiotusentals. En rak dubbelloop är hundra miljoner haversine — sekunder
 * av väntan för en planering som annars tar millisekunder.
 *
 * Rutnätet är grovt med flit: cellen är precis så stor som sökradien, så svaret ligger
 * alltid inom de nio cellerna runt frågepunkten. Ingen trädstruktur, ingen sortering,
 * ingen balansering — bara en `Map` och lite heltalsdivision.
 */
export class SightGrid {
  readonly #celler = new Map<string, Sight[]>();
  readonly #radiusM: number;
  readonly #stegLat: number;

  constructor(sights: readonly Sight[], radiusM: number = SIGHT_RADIUS_M) {
    this.#radiusM = radiusM;
    this.#stegLat = radiusM / 111_320;

    for (const s of sights) {
      const nyckel = this.#nyckel(s.at);
      const hink = this.#celler.get(nyckel);
      if (hink) hink.push(s);
      else this.#celler.set(nyckel, [s]);
    }
  }

  /**
   * Cellbredden i longitud växer med latituden — annars hade cellerna i Kiruna varit
   * halva Norrbotten breda i meter räknat, och grannskapet på 3×3 hade slutat räcka.
   */
  #stegLon(lat: number): number {
    const cos = Math.cos((lat * Math.PI) / 180);
    return this.#stegLat / Math.max(0.01, Math.abs(cos));
  }

  #nyckel([lon, lat]: LngLat): string {
    const rad = Math.floor(lat / this.#stegLat);
    const kol = Math.floor(lon / this.#stegLon(lat));
    return `${rad}:${kol}`;
  }

  /** Samma tal som `sightScore` över hela listan hade gett. Bara fortare. */
  score(at: LngLat): number {
    const [lon, lat] = at;
    const stegLon = this.#stegLon(lat);
    const rad = Math.floor(lat / this.#stegLat);
    const kol = Math.floor(lon / stegLon);

    let sum = 0;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dk = -1; dk <= 1; dk++) {
        const hink = this.#celler.get(`${rad + dr}:${kol + dk}`);
        if (!hink) continue;

        for (const s of hink) {
          const d = haversine(at, s.at);
          if (d >= this.#radiusM) continue;
          sum += SIGHT_WEIGHT[s.kind] * (1 - d / this.#radiusM);
        }
      }
    }

    return sum === 0 ? 0 : 1 - Math.exp(-sum);
  }
}
