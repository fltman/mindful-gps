# CLAUDE.md — Mindful GPS

En GPS för dig som inte har bråttom.

En vanlig GPS optimerar kortast tid. Svaret blir alltid motorvägen. Vår optimerar
upplevelse: **undvik motorväg** och **prioritera väg jag inte kört förut**.

---

## Den stående regeln

> **Appen får aldrig ha bråttom och aldrig ha rätt.**

Konkret, i kod:

- Ingen procent där kilometer duger. `"62 av 80 km är nya för dig"`, aldrig `"78 % nytt"`.
- Ingen ETA-nedräkning i sekunder. Aldrig `"du sparar 4 minuter"`.
- Ingen omberäkningsstress. Kör användaren "fel" har hen inte kört fel — hen har
  hittat en väg till.
- Frasen **"gör en U-sväng när det är möjligt"** finns inte i kodbasen. Skriver du
  den, ta bort den.
- **Tystnadsdoktrinen:** max två röstutrop per manöver. Är det 18 km till nästa sväng
  säger appen ingenting på 18 km.

## Byggs aldrig

Trafikdata. Fartvarningar. Hastighetsgränser. Sociala flöden. Streaks. Notiser som
drar in dig. **Allt som får dig att köra fortare.**

---

## Sevärdheter styr inte rutten

De **ritas på kartan** och där slutar deras makt. Det är ett mätresultat, inte en åsikt.

Vi byggde motsatsen: sevärdheter som faktor i ankarrankningen. `bench/sevardheter.ts`
dömde ut den — rutten blev **4,4 % längre och 1,7 % glesare** på sevärdheter per km.

Två skäl, och det andra är det som betyder något:

1. **Ingen hävstång.** Åtta through-punkter à 400 m styr inte vad en 14-milsrutt
   passerar. Det gör vägnätet.
2. **De drar åt fel håll.** I Sverige ligger kyrkorna, runstenarna och herrgårdarna
   längs de vägar folk *alltid* har färdats. På Växjö → Karlskrona har **baslinjen**
   högst sevärdhetstäthet av alla kandidater. Att rutta mot sevärdheter är att rutta
   tillbaka mot den vanliga vägen — precis det appen finns för att slippa.

Nyhet och sevärdheter är i konflikt, inte i samklang. Vill du bygga in dem i
planeraren igen: **kör bench först.**

---

## Låsta dörrar — och varför

Dessa motorer är utvärderade och **uteslutna**. Byt inte till dem för att någon
enskild funktion ser lockande ut.

| Motor | Varför nej |
|---|---|
| **Mapbox** | Product Terms 2.10.1: *"shall not export, download, cache or store results from any request to a Navigation API"*. Att minnas var du kört ÄR produkten. Villkoren förbjuder den. |
| **GraphHopper** | `custom_model` kräver `ch.disable=true` → inte på gratisnivån. `priority.multiply_by` får aldrig överstiga 1 → man kan straffa asfalt men inte *föredra* grus. Betald nivå ger 1 request/sekund → vår fan-out på 12 anrop tar 12 sekunder. |
| **OpenRouteService** | `avoid_features:["highways"]` träffar bara `highway=motorway` — riksväg 40 i 110 km/h slinker igenom. All undvikning är hård exkludering, inte preferens. Ingen svenska. |

**Vi kör Valhalla.** Ensam motor med de två primitiver produkten kräver:

1. `location.type: "through"` — tvinga rutten *genom* en okänd väg, utan u-sväng
   och utan eget ben. Detta är den enda mekanism i något ruttnings-API som
   **garanterar** okänd väg i rutten i stället för att hoppas på den.
2. `location.search_filter.max_road_class` — snappa via-punkten till en *liten* väg.
   Utan den snappar den till E4:an som går parallellt 300 m bort, och hela idén dör.

Dessutom: mjuk `use_highways: 0.05` (returnerar alltid en rutt — hård exkludering
ger `NoRoute` vid trafikplatser), isokroner, matris, `sv-SE`, och `trace_attributes`
med `way_id` för v2.

**Lokalt kör vi självhostad Valhalla i Docker** (ingen nyckel, inga kvoter, inga
rate limits). `ValhallaProvider` är samma klass mot en hostad Valhalla — det är en
bas-URL. Det är hela poängen med abstraktionen.

---

## Arkitektur i en mening

Ruttmotorn får **aldrig veta något om nyhet**. Den är en dum kandidatgenerator.
Nyheten är 100 % vår: vi hittar de okända vägbitarna i ett vägindex, tvingar rutten
genom dem med `through`-punkter, och poängsätter resultatet mot användarens H3-minne.
Det kostar noll extra API-anrop och körs på under en millisekund per kandidat.

## Kommandon

```bash
npm run dev            # web (5202) + server (8161) parallellt
npm run dev:web
npm run dev:server
npm run check          # tsc över alla workspaces
npm run bench          # kalibrera U(P) mot bench/routes.json — kör efter VARJE viktändring
docker start mindful-valhalla   # ruttmotorn, port 8002

# Seeda en region ur den lokala Sverige-extrakten. Vägar OCH sevärdheter, samma svep.
# Utan den svarar planeraren "N hämtningsrutor saknas" — sökellipsen är stor: en
# 14-milstur vid ε = 0,60 spänner 217 × 195 km.
npx tsx packages/server/src/roadindex/seed.ts <lon> <lat> <radie_km> [--tvinga]
```

Portar: web **5202** · server **8161** · Valhalla **8002** · Postgres **5435**.

## Regler för kod

- **`CONTRACT.md` är fruset.** Allt annat får ändras fritt. Känner du att du "bara
  måste" ändra en typ där — stanna och fråga i stället.
- Koordinater är **alltid `[lon, lat]`**. Inga undantag. API:er som vill ha `lat,lon`
  konverteras i sin adapter, aldrig i vår kod.
- `packages/core` läses av **både** klient och server. Nyhetstalet planeraren
  optimerar mot måste vara bit-identiskt med talet användaren ser. Två
  implementationer = två siffror = buggrapporter för alltid.
- Appkoden grenar **aldrig** på motorns namn (`if (engine.name === 'valhalla')`).
  Den frågar `engine.caps` och degraderar algoritmen därefter.
- Svenska i UI och kod-kommentarer. **Korrekta å, ä, ö.**
- `vault/` är privat och gitignore:ad. Aldrig i ett publikt repo.
