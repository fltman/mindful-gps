# Mindful GPS

**En GPS för dig som inte har bråttom.**

En vanlig GPS optimerar kortast tid. Svaret blir alltid motorvägen. Tänk vad man missar.

Den här optimerar upplevelse. Två inställningar, och inga fler: **undvik motorväg** och
**prioritera väg jag inte har kört förut**.

Växjö → Kalmar, samma två punkter:

| | sträcka | tid | motorväg |
|---|---|---|---|
| Vanlig GPS | 110 km | 77 min | E22 hela vägen |
| Mindful GPS | 137 km | 121 min | **0 km** |

Den sena rutten går genom Glasriket. Kör du den igen får du en **annan** väg — appen minns
var du varit, och skickar dig någon annanstans.

---

## Den stående regeln

> **Appen får aldrig ha bråttom och aldrig ha rätt.**

Konkret, i kod:

- Ingen procent där kilometer duger. `"62 av 80 km är nya för dig"`, aldrig `"78 % nytt"`.
- Ingen ETA-nedräkning i sekunder. Ankomsten sägs som en människa säger den:
  *"Du är framme i Kalmar cirka halv tio."*
- Ingen omberäkningsstress. Kör du "fel" har du inte kört fel — du har hittat en väg till.
- **Tystnadsdoktrinen:** max två röstutrop per manöver. Är det 18 km till nästa sväng
  säger appen ingenting på 18 km.
- Frasen *"gör en U-sväng när det är möjligt"* finns inte i kodbasen.

**Byggs aldrig:** trafikdata, fartvarningar, hastighetsgränser, sociala flöden, streaks,
notiser som drar in dig. Allt som får dig att köra fortare.

---

## Idén, i en mening

**Ruttmotorn får aldrig veta något om nyhet.** Den är en dum kandidatgenerator.

Nyheten är helt vår: vi hittar de okända vägbitarna i ett eget vägindex, **tvingar** rutten
genom dem med `through`-punkter, och poängsätter resultatet mot användarens H3-minne. Det
kostar noll extra API-anrop och körs på under en millisekund per kandidat.

Skillnaden mot att sampla slumpmässiga omvägar och hoppas är hela produkten: `through`
**garanterar** okänd väg i rutten i stället för att hoppas på den.

### Varför Valhalla, och inte något annat

| Motor | Varför nej |
|---|---|
| **Mapbox** | Product Terms 2.10.1: *"shall not export, download, cache or store results from any request to a Navigation API"*. Att minnas var du kört ÄR produkten. Villkoren förbjuder den. |
| **GraphHopper** | `priority.multiply_by` får aldrig överstiga 1 → man kan straffa asfalt, men inte *föredra* grus. `custom_model` kräver `ch.disable=true`, som inte finns på gratisnivån. |
| **OpenRouteService** | `avoid_features:["highways"]` träffar bara `highway=motorway` — riksväg 40 i 110 km/h slinker igenom. All undvikning är hård exkludering, inte preferens. |

Valhalla är den enda motorn med de två primitiver produkten kräver:

1. `location.type: "through"` — tvinga rutten *genom* en okänd väg, utan u-sväng och utan
   eget ben.
2. `location.search_filter.max_road_class` — snappa via-punkten till en **liten** väg. Utan
   den snappar den till E4:an som går parallellt 300 m bort, och hela idén dör.

Vi kör den självhostad i Docker. Ingen nyckel, inga kvoter, inga rate limits.

---

## Vad mätningarna sa nej till

Bench:en finns för att stoppa idéer som låter bra. Två gjorde det:

**Sevärdheter får inte styra rutten.** Vi byggde det: sevärdheter som faktor i
ankarrankningen, så planeraren hellre valde den okända vägen som gick förbi en runsten.
Rutten blev **4,4 % längre och 1,7 % glesare** på sevärdheter per kilometer.

Skälet är värt att äga: i Sverige ligger kyrkorna, runstenarna och herrgårdarna längs de
vägar folk *alltid* har färdats. Att tvinga rutten ut på okänd småväg flyttar den per
definition **bort** från dem. Nyhet och sevärdheter är i konflikt, inte i samklang. De
ritas på kartan i stället, och styr ingenting. (`bench/sevardheter.ts`)

**"Ditt nät" får aldrig komma ur odometern.** En pendlare som kört samma fyra mil till
jobbet 200 gånger har ett nät på 40 km, inte 8 000. Summerar man turernas längd gratulerar
appen honom för upprepning — precis det beteende den finns för att bryta. Nätet räknas ur
H3-cellerna, alltid.

---

## Kom igång

Kräver Docker, Node 22+ och `osmium-tool`.

```bash
npm install
cp .env.example .env

# Ruttmotorn: Valhalla med svenska OSM-tiles (bygget tar en stund första gången)
docker start mindful-valhalla

# Vägindexet: seeda den region du vill köra i, ur den lokala OSM-extrakten.
# Sökellipsen är stor — en 14-milstur vid ε = 0,60 spänner 217 × 195 km.
npx tsx packages/server/src/roadindex/seed.ts 14.80 56.88 140

npm run dev        # web på 5202, server på 8161
```

Simulera en körning utan att sätta dig i bilen:

```
http://localhost:5202/?sim=1&start=14.8059,56.8777&takt=40
```

### Kommandon

```bash
npm run check    # tsc över alla workspaces
npm run bench    # kalibrera vikterna — kör efter VARJE viktändring
```

---

## Arkitektur

```
packages/core     delad kärna — läses av BÅDE klient och server.
                  Nyhetstalet planeraren optimerar mot måste vara bit-identiskt
                  med talet användaren ser. Två implementationer = två siffror.
packages/server   Fastify + PostGIS. Ruttmotor-abstraktion, vägindex, planeraren.
packages/web      Vite + React + MapLibre. Minnet i IndexedDB, synkat mot servern.
bench/            mätningarna som avgör vikterna. Aldrig magkänsla på en biltur.
```

`CONTRACT.md` är fruset och är sanningen om typerna. `CLAUDE.md` är reglerna för
den som skriver kod här.

Koordinater är **alltid** `[lon, lat]`. Inga undantag.

---

## Licens

Koden är [MIT](LICENSE).

Kartdata från [OpenStreetMap](https://www.openstreetmap.org/copyright) — **ODbL**, och den
smittar inte koden men följer med datan: bygger du en tjänst på OSM-härledd data ska du
ange källan och dela tillbaka förbättringar av själva datan.

Vektorkakel från [OpenFreeMap](https://openfreemap.org/).
Ruttning med [Valhalla](https://github.com/valhalla/valhalla) (MIT).
