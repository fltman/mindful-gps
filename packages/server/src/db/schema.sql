-- Schemat ur CONTRACT §3.5, serversidan.
--
-- Körs i sin helhet vid varje uppstart (db/pool.ts). Allt är därför IF NOT EXISTS:
-- filen är en beskrivning av hur databasen SKA se ut, inte en migrering som körs en gång.
--
-- H3-celler lagras som BIGINT. En H3-cell har alltid nollställd toppbit, så u64:an får
-- plats i Postgres signerade int8 utan trunkering. Hex-strängar hade kostat 15 byte per
-- cell och gjort sorteringen till en strängjämförelse.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ─── Identitet ──────────────────────────────────────────────────────────────
--
-- Ingen inloggning i v1. Enheten ÄR identiteten (X-Device-Id). `user_id` finns redan
-- överallt, nullbar, så att Fas 3 blir en UPDATE och inte en migrering.

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id          uuid PRIMARY KEY,                       -- uuid:t klienten själv genererat
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);

-- ─── Turerna ────────────────────────────────────────────────────────────────
--
-- `id` är klientens uuid, inte ett serverserienummer. Det är hela idempotensen:
-- samma tur skickad två gånger blir en ON CONFLICT DO NOTHING, och besöken räknas
-- inte om.
--
-- Råspåret (`polyline6`) är sanningen och raderas aldrig. `geom` är en cache av samma
-- geometri i en form PostGIS kan indexera.

CREATE TABLE IF NOT EXISTS trips (
  id           uuid PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('free', 'nav_ab', 'nav_loop', 'explore')),
  polyline6    text NOT NULL,
  distance_m   double precision NOT NULL,
  gaps         jsonb NOT NULL DEFAULT '[]'::jsonb,    -- ärlighet: här tappade vi signalen
  geom         geometry(LineString, 4326),            -- NULL om spåret har < 2 punkter
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trips_device_started_idx ON trips (device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS trips_geom_idx ON trips USING GIST (geom);

-- ─── Nyhetsminnet ───────────────────────────────────────────────────────────
--
-- En rad per (enhet, cell). `visits` mättar vid 255 (u8 i kontraktet), `last_seen_day`
-- är dagar sedan EPOCH_DAY0 (u16), `axis_mask` fyra axelbitar à 45°.
--
-- `pt` är en representativ punkt INUTI cellen — den fix vi faktiskt observerade där.
-- Cellen är ~50 m bred, så punkten duger gott som ankare för en bbox-fråga i km-skala,
-- och vi slipper räkna cellcentrum utanför h3util (kontraktets gräns mot h3-js).

CREATE TABLE IF NOT EXISTS visited_cells (
  device_id      uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  h3             bigint NOT NULL,
  visits         smallint NOT NULL DEFAULT 1 CHECK (visits BETWEEN 0 AND 255),
  last_seen_day  integer NOT NULL,
  axis_mask      smallint NOT NULL DEFAULT 0 CHECK (axis_mask BETWEEN 0 AND 15),
  pt             geometry(Point, 4326) NOT NULL,
  PRIMARY KEY (device_id, h3)
);

CREATE INDEX IF NOT EXISTS visited_cells_pt_idx ON visited_cells USING GIST (pt);

-- ─── Vägindexet — Fas 2 ─────────────────────────────────────────────────────
--
-- Ligger här redan nu därför att tomma tabeller inte kostar något, och därför att
-- CONTRACT §4 fryser formen på dem. Ingen kod skriver till dem ännu.
--
-- `road_tile` är bokföringen över vilka res-6-rutor (~36 km) vi hämtat vägdata för —
-- utan den vet ingen om en tom ruta betyder "inga vägar" eller "aldrig hämtad".

CREATE TABLE IF NOT EXISTS road_tile (
  h3_6        bigint PRIMARY KEY,                     -- res-6-förälder (H3_SHARD_RES)
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  segments    integer NOT NULL DEFAULT 0
);

-- Segmenteras i ~400 m-bitar VID INGEST (SEGMENT_LENGTH_M). En hel OSM-way vore fel
-- kornighet: efter ett halvår hemma är nästan varje way DELVIS körd, och den binära
-- frågan "finns en okörd way?" ger noll träffar precis där produkten ska leverera.
CREATE TABLE IF NOT EXISTS road_segment (
  id             bigserial PRIMARY KEY,
  tile_h3_6      bigint NOT NULL REFERENCES road_tile(h3_6) ON DELETE CASCADE,
  way_id         bigint NOT NULL,
  cls            text NOT NULL,
  surface        text NOT NULL,
  name           text,
  ref            text,
  length_m       double precision NOT NULL,
  shape          geometry(LineString, 4326) NOT NULL,
  h3             bigint[] NOT NULL,                   -- ~10 celler vid res 11
  curvature_dpk  double precision NOT NULL            -- grader per km, förberäknad
);

CREATE INDEX IF NOT EXISTS road_segment_tile_idx ON road_segment (tile_h3_6);
CREATE INDEX IF NOT EXISTS road_segment_shape_idx ON road_segment USING GIST (shape);
CREATE INDEX IF NOT EXISTS road_segment_h3_idx ON road_segment USING GIN (h3);

-- ── Sevärdheter ────────────────────────────────────────────────────────────
-- Det som gör en okänd väg värd att köra. De DRAR rutten till sig i ankarrankningen;
-- de föreslår aldrig att du stannar.
--
-- Bokförs i SAMMA res-6-rutor som vägarna, och seedas i samma svep. En egen bokföring
-- hade betytt en region där vägarna finns men sevärdheterna inte — och då hade
-- planeraren tyst slutat bry sig om dem, utan att någon märkte något.
CREATE TABLE IF NOT EXISTS sight (
  id          bigint PRIMARY KEY,                    -- OSM-id, med n/w/r inbakat
  tile_h3_6   bigint NOT NULL REFERENCES road_tile(h3_6) ON DELETE CASCADE,
  kind        text NOT NULL,
  name        text NOT NULL DEFAULT '',
  at          geometry(Point, 4326) NOT NULL         -- ytor reduceras till sin mittpunkt
);

CREATE INDEX IF NOT EXISTS sight_tile_idx ON sight (tile_h3_6);
CREATE INDEX IF NOT EXISTS sight_at_idx ON sight USING GIST (at);

-- ── Berättelser ────────────────────────────────────────────────────────────
-- En AI-skriven text om en sevärdhet, och dess uppläsning. Komponeras EN gång per
-- sevärdhet och återanvänds för alltid: andra personen som trycker på Kosta glasbruk får
-- samma text direkt och gratis. Ett anrop till en betald modell per plats i hela Sverige,
-- inte per tryck.
--
-- `ljud` fylls först när någon faktiskt bett om uppläsning — de flesta läser texten och
-- kör vidare, och ElevenLabs är det dyra steget.
CREATE TABLE IF NOT EXISTS sight_story (
  sight_id   bigint PRIMARY KEY REFERENCES sight(id) ON DELETE CASCADE,
  text       text NOT NULL,
  sources    jsonb NOT NULL DEFAULT '[]'::jsonb,
  audio      bytea,                                   -- mp3, null tills uppläst första gången
  created_at timestamptz NOT NULL DEFAULT now()
);
