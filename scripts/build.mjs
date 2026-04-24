#!/usr/bin/env node
// Builds the FlowPure postcode-polygons mirror from open sources.
// Run with: `node scripts/build.mjs [country]` where country ∈ {gb, au, de, us, nl, dk, all}.
// Default: all.
//
// Each country ends up with GeoJSON files under ./<country>/ where every
// feature has `properties.name = <postcode>`. Files are minified JSON.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrotliDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, PassThrough } from "node:stream";
import simplify from "@turf/simplify";
import centroid from "@turf/centroid";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import bbox from "@turf/bbox";

// Geometry simplification tolerance (degrees). 0.0005 ≈ 55 m at the
// equator — plenty of fidelity for a phone map, dramatically smaller files.
const SIMPLIFY_TOLERANCE = 0.0005;

// Round coordinates to 5 decimal places (~1.1 m precision at equator) to
// drop useless noise digits and shrink files further.
function roundCoord(c) {
  if (Array.isArray(c)) return c.map(roundCoord);
  if (typeof c === "number") return Math.round(c * 1e5) / 1e5;
  return c;
}

function simplifyFeature(feature) {
  if (!feature?.geometry) return feature;
  let simplified;
  try {
    simplified = simplify(feature, {
      tolerance: SIMPLIFY_TOLERANCE,
      highQuality: false,
      mutate: false,
    });
  } catch {
    simplified = feature;
  }
  // Strip coord precision + drop any 3rd Z axis that some datasets include.
  if (simplified.geometry) {
    simplified.geometry.coordinates = roundCoord(
      stripZ(simplified.geometry.coordinates)
    );
  }
  return simplified;
}

// Drops any 3rd element (e.g., elevation "-999") from coordinate arrays so
// we only ship [lng, lat].
function stripZ(coords) {
  if (!Array.isArray(coords)) return coords;
  if (coords.length && typeof coords[0] === "number") {
    return coords.length > 2 ? [coords[0], coords[1]] : coords;
  }
  return coords.map(stripZ);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Helpers ──────────────────────────────────────────────────────────────

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "FlowPureApp-Maps builder" },
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "FlowPureApp-Maps builder" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function brotliDecompress(buffer) {
  const input = Readable.from(buffer);
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (c) => chunks.push(c));
  await pipeline(input, createBrotliDecompress(), output);
  return Buffer.concat(chunks).toString("utf8");
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeFeatureCollection(path, features) {
  const fc = { type: "FeatureCollection", features };
  writeFileSync(path, JSON.stringify(fc));
}

// Normalises + simplifies a feature: maps an existing property to `name`,
// runs geometry through the simplifier, rounds + strips Z.
function normalizeFeature(feature, codeProp) {
  const raw = feature.properties?.[codeProp];
  if (raw == null) return null;
  const name = String(raw).trim();
  if (!name) return null;
  const bare = {
    type: "Feature",
    properties: { name },
    geometry: feature.geometry,
  };
  return simplifyFeature(bare);
}

function log(country, msg) {
  process.stdout.write(`[${country}] ${msg}\n`);
}

// ─── Country builders ─────────────────────────────────────────────────────

// GB — 124 per-area files from missinglink/uk-postcode-polygons. Property
// already uses `name`; we just proxy them through unchanged.
async function buildGb() {
  const outDir = join(ROOT, "gb");
  ensureDir(outDir);

  const api = "https://api.github.com/repos/missinglink/uk-postcode-polygons/contents/geojson";
  const listing = await fetchJson(api);
  const files = listing
    .filter((f) => f.name.endsWith(".geojson"))
    .map((f) => f.name);
  log("gb", `${files.length} area files to mirror`);

  for (const filename of files) {
    const raw = `https://raw.githubusercontent.com/missinglink/uk-postcode-polygons/master/geojson/${filename}`;
    const text = await fetchText(raw);
    // Parse + re-serialize minified to be safe.
    const fc = JSON.parse(text);
    writeFileSync(join(outDir, filename), JSON.stringify(fc));
  }
  log("gb", `done — wrote ${files.length} files`);
}

// AU — Offbeatmammal/AU_Postcode_Map provides one 34 MB file with all POAs.
// We split by first digit of POA_CODE_2021 so the app only downloads the
// region of interest.
async function buildAu() {
  const outDir = join(ROOT, "au");
  ensureDir(outDir);

  const url = "https://raw.githubusercontent.com/Offbeatmammal/AU_Postcode_Map/master/POA_2021_AUST_GDA2020_15percent.json";
  log("au", "downloading POA 2021 simplified (~34 MB)…");
  const fc = await fetchJson(url);
  log("au", `${fc.features.length} POAs total`);

  const buckets = new Map(); // digit → features[]
  for (const f of fc.features) {
    const norm = normalizeFeature(f, "POA_CODE21");
    if (!norm) continue;
    const digit = norm.properties.name[0] ?? "0";
    if (!buckets.has(digit)) buckets.set(digit, []);
    buckets.get(digit).push(norm);
  }
  for (const [digit, feats] of buckets) {
    writeFeatureCollection(join(outDir, `${digit}.geojson`), feats);
    log("au", `  ${digit}.geojson — ${feats.length} POAs`);
  }
  log("au", `done — wrote ${buckets.size} files`);
}

// DE — yetzt/postleitzahlen releases a Brotli-compressed GeoJSON with all
// 8,200 PLZ. We decompress then split by first digit (10 files).
async function buildDe() {
  const outDir = join(ROOT, "de");
  ensureDir(outDir);

  const url = "https://github.com/yetzt/postleitzahlen/releases/download/2026.02/postleitzahlen.geojson.br";
  log("de", "downloading compressed PLZ release…");
  const compressed = await fetchBuffer(url);
  log("de", `compressed ${(compressed.length / 1024 / 1024).toFixed(1)} MB — decompressing`);
  const text = await brotliDecompress(compressed);
  const fc = JSON.parse(text);
  log("de", `${fc.features.length} PLZ total`);

  const buckets = new Map();
  for (const f of fc.features) {
    // yetzt/postleitzahlen uses `postcode` as the property key.
    const norm = normalizeFeature(f, "postcode");
    if (!norm) continue;
    const digit = norm.properties.name[0] ?? "0";
    if (!buckets.has(digit)) buckets.set(digit, []);
    buckets.get(digit).push(norm);
  }
  for (const [digit, feats] of buckets) {
    writeFeatureCollection(join(outDir, `${digit}.geojson`), feats);
    log("de", `  ${digit}.geojson — ${feats.length} PLZ`);
  }
  log("de", `done — wrote ${buckets.size} files`);
}

// US — OpenDataDE/State-zip-code-GeoJSON has per-state files, but we
// consolidate then re-split by the ZIP code's first digit (10 buckets)
// so the runtime parser doesn't need a ZIP→state lookup table. A user in
// California (ZIP 902…) and Washington (ZIP 98…) both land in bucket `9`.
async function buildUs() {
  const outDir = join(ROOT, "us");
  ensureDir(outDir);

  const api = "https://api.github.com/repos/OpenDataDE/State-zip-code-GeoJSON/contents/";
  const listing = await fetchJson(api);
  const zipFiles = listing
    .filter((f) => f.name.endsWith("_zip_codes_geo.min.json"))
    .map((f) => ({
      state: f.name.slice(0, 2),
      download: f.download_url,
    }));
  log("us", `${zipFiles.length} state files to fetch + redistribute by first digit`);

  const buckets = new Map(); // digit → features[]
  for (const { state, download } of zipFiles) {
    const text = await fetchText(download);
    const fc = JSON.parse(text);
    // OpenDataDE uses `ZCTA5CE10` for the ZIP property.
    for (const f of fc.features) {
      const norm = normalizeFeature(f, "ZCTA5CE10");
      if (!norm) continue;
      const digit = norm.properties.name[0] ?? "0";
      if (!buckets.has(digit)) buckets.set(digit, []);
      buckets.get(digit).push(norm);
    }
    log("us", `  pulled ${state}`);
  }

  for (const [digit, feats] of [...buckets.entries()].sort()) {
    writeFeatureCollection(join(outDir, `${digit}.geojson`), feats);
    log("us", `  ${digit}.geojson — ${feats.length} ZIPs`);
  }
  log("us", `done — wrote ${buckets.size} files`);
}

// NL — PC4 polygons from Opendatasoft's georef dataset. One file, ~4,000 areas.
async function buildNl() {
  const outDir = join(ROOT, "nl");
  ensureDir(outDir);

  const url = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-netherlands-postcode-pc4/exports/geojson?lang=en&timezone=UTC";
  log("nl", "downloading Opendatasoft PC4 export…");
  const fc = await fetchJson(url);
  log("nl", `${fc.features.length} PC4 areas`);

  // Opendatasoft uses `pc4_code` (or possibly `pc4`) — try both.
  const features = fc.features
    .map((f) => {
      const code =
        f.properties?.pc4_code ??
        f.properties?.pc4 ??
        f.properties?.postcode;
      if (code == null) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: String(code).trim() },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(outDir, "pc4.geojson"), features);
  log("nl", `done — wrote pc4.geojson with ${features.length} areas`);
}

// DK — Neogeografen/dagi has a single postnumre.geojson with ~600 entries.
async function buildDk() {
  const outDir = join(ROOT, "dk");
  ensureDir(outDir);

  const url = "https://raw.githubusercontent.com/Neogeografen/dagi/master/geojson/postnumre.geojson";
  log("dk", "downloading postnumre.geojson…");
  const fc = await fetchJson(url);
  log("dk", `${fc.features.length} postal codes`);

  // dagi uses `POSTNR_TXT` for the postal code (string, 4 digits).
  const features = fc.features
    .map((f) => {
      const code =
        f.properties?.POSTNR_TXT ??
        f.properties?.postnr ??
        f.properties?.postcode;
      if (code == null) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: String(code).trim() },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(outDir, "postnumre.geojson"), features);
  log("dk", `done — wrote postnumre.geojson with ${features.length} codes`);
}

// ─── Region-outline builders (fallback polygons) ──────────────────────────
//
// These produce a single `<country>/regions.geojson` holding broad
// admin-region polygons (states / Bundesländer / provinces / regions),
// used by the app when an exact postcode polygon isn't available.
// Every feature is normalised to `properties.name = <short region code>`.

// Merges features sharing the same `properties.name` into a single
// MultiPolygon. Used when source data ships islands as separate features.
function mergeByName(features) {
  const byName = new Map();
  for (const f of features) {
    const n = f.properties?.name;
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f);
  }
  return [...byName.entries()].map(([name, feats]) => {
    if (feats.length === 1) return feats[0];
    const coords = [];
    for (const f of feats) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") coords.push(g.coordinates);
      else if (g.type === "MultiPolygon") coords.push(...g.coordinates);
    }
    return {
      type: "Feature",
      properties: { name },
      geometry: { type: "MultiPolygon", coordinates: coords },
    };
  });
}

// AU — 8 states + territories. Source property STATE_NAME maps to our
// short lowercase codes (nsw, vic, …).
async function buildAuRegions() {
  const AU_NAME_TO_CODE = {
    "New South Wales": "nsw",
    "Victoria": "vic",
    "Queensland": "qld",
    "South Australia": "sa",
    "Western Australia": "wa",
    "Tasmania": "tas",
    "Northern Territory": "nt",
    "Australian Capital Territory": "act",
  };
  log("au-regions", "downloading state outlines…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/rowanhogan/australian-states/master/states.geojson"
  );
  const features = fc.features
    .map((f) => {
      const code = AU_NAME_TO_CODE[f.properties?.STATE_NAME];
      if (!code) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: code },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "au", "regions.geojson"), features);
  log("au-regions", `done — ${features.length} state outlines`);
}

// DE — 16 Bundesländer. Source `id` is ISO 3166-2 like "DE-BW"; we strip
// the prefix and lowercase to `bw`.
async function buildDeRegions() {
  log("de-regions", "downloading Bundesländer outlines…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/isellsoap/deutschlandGeoJSON/master/2_bundeslaender/4_niedrig.geo.json"
  );
  const features = fc.features
    .map((f) => {
      const id = f.properties?.id ?? "";
      const code = id.replace(/^DE-/, "").toLowerCase();
      if (!code) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: code },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "de", "regions.geojson"), features);
  log("de-regions", `done — ${features.length} Bundesländer`);
}

// US — 50 states + DC. Source uses `name` with full state name; we map to
// 2-letter USPS codes. We also emit `us/zip3-state.json`, a
// ZIP-first-3-digits → state-code lookup derived from the zip files we
// already built, so the app can resolve a user's state from their ZIP.
const US_STATE_NAME_TO_CODE = {
  Alabama: "al", Alaska: "ak", Arizona: "az", Arkansas: "ar",
  California: "ca", Colorado: "co", Connecticut: "ct", Delaware: "de",
  "District of Columbia": "dc", Florida: "fl", Georgia: "ga", Hawaii: "hi",
  Idaho: "id", Illinois: "il", Indiana: "in", Iowa: "ia",
  Kansas: "ks", Kentucky: "ky", Louisiana: "la", Maine: "me",
  Maryland: "md", Massachusetts: "ma", Michigan: "mi", Minnesota: "mn",
  Mississippi: "ms", Missouri: "mo", Montana: "mt", Nebraska: "ne",
  Nevada: "nv", "New Hampshire": "nh", "New Jersey": "nj",
  "New Mexico": "nm", "New York": "ny", "North Carolina": "nc",
  "North Dakota": "nd", Ohio: "oh", Oklahoma: "ok", Oregon: "or",
  Pennsylvania: "pa", "Rhode Island": "ri", "South Carolina": "sc",
  "South Dakota": "sd", Tennessee: "tn", Texas: "tx", Utah: "ut",
  Vermont: "vt", Virginia: "va", Washington: "wa", "West Virginia": "wv",
  Wisconsin: "wi", Wyoming: "wy", "Puerto Rico": "pr",
};

async function buildUsRegions() {
  log("us-regions", "downloading state outlines…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json"
  );
  const features = fc.features
    .map((f) => {
      const code = US_STATE_NAME_TO_CODE[f.properties?.name];
      if (!code) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: code },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "us", "regions.geojson"), features);
  log("us-regions", `done — ${features.length} state outlines`);

  // Derive ZIP3 → state mapping from the already-built us/*.geojson files.
  // Uses the ORIGINAL OpenDataDE sources (re-fetched) so we have state info.
  log("us-regions", "building zip3→state index…");
  const api = "https://api.github.com/repos/OpenDataDE/State-zip-code-GeoJSON/contents/";
  const listing = await fetchJson(api);
  const zipFiles = listing
    .filter((f) => f.name.endsWith("_zip_codes_geo.min.json"))
    .map((f) => ({ state: f.name.slice(0, 2), download: f.download_url }));

  const zip3Map = {};
  for (const { state, download } of zipFiles) {
    const text = await fetchText(download);
    const j = JSON.parse(text);
    for (const f of j.features) {
      const zip = String(f.properties?.ZCTA5CE10 ?? "").padStart(5, "0");
      if (zip.length !== 5) continue;
      const prefix = zip.slice(0, 3);
      // Don't overwrite — first state to claim a ZIP3 wins. (Rare that
      // a ZIP3 spans states; picking the first is an acceptable approximation.)
      if (!zip3Map[prefix]) zip3Map[prefix] = state;
    }
  }
  writeFileSync(join(ROOT, "us", "zip3-state.json"), JSON.stringify(zip3Map));
  log("us-regions", `done — ${Object.keys(zip3Map).length} zip3 prefixes`);
}

// NL — 12 provinces. Source `statnaam` is the province name; we map to
// 2-letter abbreviations.
async function buildNlRegions() {
  const NL_NAME_TO_CODE = {
    Groningen: "gr", Fryslân: "fr", Friesland: "fr", Drenthe: "dr",
    Overijssel: "ov", Flevoland: "fl", Gelderland: "ge", Utrecht: "ut",
    "Noord-Holland": "nh", "Zuid-Holland": "zh", Zeeland: "ze",
    "Noord-Brabant": "nb", Limburg: "li",
  };
  log("nl-regions", "downloading province outlines…");
  const fc = await fetchJson(
    "https://cartomap.github.io/nl/wgs84/provincie_2023.geojson"
  );
  const features = fc.features
    .map((f) => {
      const code = NL_NAME_TO_CODE[f.properties?.statnaam];
      if (!code) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: code },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "nl", "regions.geojson"), features);
  log("nl-regions", `done — ${features.length} provinces`);
}

// DK — 5 regions. Source has 222 island-split features; we merge by region
// code into 5 MultiPolygon entries.
async function buildDkRegions() {
  const DK_CODE_TO_SHORT = {
    "1084": "hovedstaden",
    "1081": "nordjylland",
    "1083": "syddanmark",
    "1085": "sjaelland",
    "1082": "midtjylland",
  };
  log("dk-regions", "downloading region outlines…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/Neogeografen/dagi/master/geojson/regioner.geojson"
  );
  const simplified = fc.features
    .map((f) => {
      const short = DK_CODE_TO_SHORT[f.properties?.REGIONKODE];
      if (!short) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: short },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  const merged = mergeByName(simplified);
  writeFeatureCollection(join(ROOT, "dk", "regions.geojson"), merged);
  log("dk-regions", `done — ${merged.length} regions (from ${simplified.length} island pieces)`);
}

// ─── Admin-tier fallback builders (counties / LGAs / Kreise / LADs) ──────
//
// For each country these build a `<country>/admin.geojson` with finer-grain
// admin polygons and a `<country>/admin-lookup.json` mapping every known
// postcode to its admin area. The lookup is auto-derived by checking which
// admin polygon contains each postcode feature's centroid.

// Box-index optimisation — without this, spatial-joining 33k ZIPs against
// 3k counties is O(100M) which is too slow. We pre-compute each admin
// polygon's bounding box and filter candidates by bbox before running the
// exact point-in-polygon test.
function indexAdmin(adminFeatures) {
  return adminFeatures.map((f) => {
    const [minX, minY, maxX, maxY] = bbox(f);
    return { f, minX, minY, maxX, maxY };
  });
}

function findContainingAdmin(point, index) {
  const coords = point?.geometry?.coordinates;
  if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
    return null;
  }
  const [x, y] = coords;
  for (const e of index) {
    if (x < e.minX || x > e.maxX || y < e.minY || y > e.maxY) continue;
    try {
      if (booleanPointInPolygon(point, e.f)) return e.f;
    } catch {
      // Malformed admin polygon — skip this one, try the next.
    }
  }
  return null;
}

// Given a country's existing postcode files + a set of admin features,
// build and write `<country>/admin-lookup.json` mapping postcode → admin
// code. ALSO emits prefix entries (keys "p:<digits>") so postcodes we
// don't have exact data for can still resolve to the most-common admin
// area for their prefix. Prefix lengths depend on the country's postcode
// size — e.g. AU (4-digit) gets prefixes of length 1/2/3.
function buildAdminLookup(
  country,
  countryFolder,
  postcodeFiles,
  adminFeatures,
  { prefixLengths = [] } = {}
) {
  const index = indexAdmin(adminFeatures);
  const lookup = {};
  let matched = 0;
  let unmatched = 0;
  // For prefix aggregation: for each prefix length, count admin occurrences
  // so we can pick the mode.
  const prefixCounts = new Map(); // `${len}:${prefix}` → Map<adminCode, count>

  for (const file of postcodeFiles) {
    const path = join(ROOT, countryFolder, file);
    if (!existsSync(path)) continue;
    const fc = JSON.parse(readFileSync(path, "utf8"));
    for (const pc of fc.features) {
      const code = pc.properties?.name;
      if (!code) continue;
      let c;
      try {
        c = centroid(pc);
      } catch {
        unmatched++;
        continue;
      }
      const admin = findContainingAdmin(c, index);
      if (admin) {
        const adminCode = admin.properties.name;
        lookup[code] = adminCode;
        matched++;
        // Tally for each requested prefix length.
        for (const len of prefixLengths) {
          if (code.length < len) continue;
          const prefix = code.slice(0, len);
          const key = `${len}:${prefix}`;
          if (!prefixCounts.has(key)) prefixCounts.set(key, new Map());
          const inner = prefixCounts.get(key);
          inner.set(adminCode, (inner.get(adminCode) ?? 0) + 1);
        }
      } else {
        unmatched++;
      }
    }
  }

  // Pick mode per prefix and emit `p:<prefix>` keys.
  let prefixesAdded = 0;
  for (const [key, adminCounts] of prefixCounts) {
    const prefix = key.split(":")[1];
    let winner = null;
    let winnerCount = 0;
    for (const [adminCode, count] of adminCounts) {
      if (count > winnerCount) {
        winner = adminCode;
        winnerCount = count;
      }
    }
    if (winner) {
      lookup[`p:${prefix}`] = winner;
      prefixesAdded++;
    }
  }

  writeFileSync(
    join(ROOT, countryFolder, "admin-lookup.json"),
    JSON.stringify(lookup)
  );
  log(
    country,
    `  admin-lookup.json — ${matched} exact, ${prefixesAdded} prefix, ${unmatched} unmatched`
  );
  return { matched, unmatched, prefixesAdded };
}

// Helper: slugify an admin-region display name to a lowercase code with
// hyphens, safe as a URL-friendly feature id.
function slug(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// AU — ~565 LGAs from thomjoy/aus-lga. Property LGA_NAME11 holds names
// like "Albury (C)"; we slug them (e.g. "albury-c") for feature IDs.
async function buildAuAdmin() {
  log("au-admin", "downloading LGA boundaries…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/thomjoy/aus-lga/master/data/aus_lga.json"
  );
  const nameByCode = new Map();
  const features = fc.features
    .map((f) => {
      const display = f.properties?.LGA_NAME11;
      if (!display) return null;
      const code = slug(display);
      if (!code) return null;
      nameByCode.set(code, display);
      return simplifyFeature({
        type: "Feature",
        properties: { name: code, displayName: display },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "au", "admin.geojson"), features);
  log("au-admin", `  admin.geojson — ${features.length} LGAs`);

  // Build the postcode → LGA lookup. AU postcodes live in au/0…9.geojson
  // except the stray Z.geojson; ignore that one.
  const postcodeFiles = ["0", "2", "3", "4", "5", "6", "7", "9"].map((d) => `${d}.geojson`);
  buildAdminLookup("au-admin", "au", postcodeFiles, features, {
    prefixLengths: [1, 2, 3], // 4-digit postcodes → try 3, 2, 1
  });
  log("au-admin", "done");
}

// DE — ~434 Kreise from isellsoap/deutschlandGeoJSON. The GADM-derived
// file carries NAME_3 for the Kreis name (e.g. "München").
async function buildDeAdmin() {
  log("de-admin", "downloading Kreis boundaries…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/isellsoap/deutschlandGeoJSON/main/4_kreise/4_niedrig.geo.json"
  );
  const features = fc.features
    .map((f) => {
      const display = f.properties?.NAME_3;
      if (!display) return null;
      const code = slug(display);
      if (!code) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: code, displayName: display },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "de", "admin.geojson"), features);
  log("de-admin", `  admin.geojson — ${features.length} Kreise`);

  const postcodeFiles = ["0","1","2","3","4","5","6","7","8","9"].map((d) => `${d}.geojson`);
  buildAdminLookup("de-admin", "de", postcodeFiles, features, {
    prefixLengths: [1, 2, 3, 4], // 5-digit PLZ → prefixes 4/3/2/1
  });
  log("de-admin", "done");
}

// UK — 380 Local Authority Districts from martinjc/UK-GeoJSON. LAD13CD
// is the official ONS code (e.g. "E06000001"); we lowercase it.
async function buildGbAdmin() {
  log("gb-admin", "downloading LAD boundaries…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/gb/lad.json"
  );
  const features = fc.features
    .map((f) => {
      const displayName = f.properties?.LAD13NM;
      const code = (f.properties?.LAD13CD ?? "").toLowerCase();
      if (!code || !displayName) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: code, displayName },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "gb", "admin.geojson"), features);
  log("gb-admin", `  admin.geojson — ${features.length} LADs`);

  // GB postcode files are the 120 area files we mirrored from missinglink.
  // Walk them all from the directory rather than enumerating.
  const postcodeFiles = readdirSync(join(ROOT, "gb")).filter(
    (f) => f.endsWith(".geojson") && f !== "admin.geojson" && f !== "regions.geojson"
  );
  // GB district codes are letter(s)+digit(s), e.g. "SE10". Prefix
  // lengths 2 (the "outward area") and 3 cover most cases usefully.
  buildAdminLookup("gb-admin", "gb", postcodeFiles, features, {
    prefixLengths: [1, 2, 3],
  });
  log("gb-admin", "done");
}

// US — 3,221 counties from plotly/datasets. GEO_ID like "0500000US01001"
// where the last 5 chars are state-FIPS + county-FIPS; we use that suffix
// as the code (e.g. "01001" for Autauga, AL).
async function buildUsAdmin() {
  log("us-admin", "downloading county boundaries (~10 MB)…");
  const fc = await fetchJson(
    "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json"
  );
  const features = fc.features
    .map((f) => {
      const geoId = String(f.properties?.GEO_ID ?? "");
      const code = geoId.slice(-5); // 5-digit FIPS
      const displayName = f.properties?.NAME;
      if (!code || !displayName) return null;
      return simplifyFeature({
        type: "Feature",
        properties: { name: code, displayName },
        geometry: f.geometry,
      });
    })
    .filter(Boolean);
  writeFeatureCollection(join(ROOT, "us", "admin.geojson"), features);
  log("us-admin", `  admin.geojson — ${features.length} counties`);

  const postcodeFiles = ["0","1","2","3","4","5","6","7","8","9"].map((d) => `${d}.geojson`);
  buildAdminLookup("us-admin", "us", postcodeFiles, features, {
    prefixLengths: [1, 2, 3, 4], // 5-digit ZIPs; ZIP3 is the classic USPS unit
  });
  log("us-admin", "done");
}

// ─── Entry ────────────────────────────────────────────────────────────────

const BUILDERS = {
  gb: buildGb,
  au: buildAu,
  de: buildDe,
  us: buildUs,
  nl: buildNl,
  dk: buildDk,
  "au-regions": buildAuRegions,
  "de-regions": buildDeRegions,
  "us-regions": buildUsRegions,
  "nl-regions": buildNlRegions,
  "dk-regions": buildDkRegions,
  regions: async () => {
    await buildAuRegions();
    await buildDeRegions();
    await buildUsRegions();
    await buildNlRegions();
    await buildDkRegions();
  },
  "au-admin": buildAuAdmin,
  "de-admin": buildDeAdmin,
  "gb-admin": buildGbAdmin,
  "us-admin": buildUsAdmin,
  admin: async () => {
    await buildAuAdmin();
    await buildDeAdmin();
    await buildGbAdmin();
    await buildUsAdmin();
  },
};

async function main() {
  const arg = (process.argv[2] ?? "all").toLowerCase();
  const targets = arg === "all" ? Object.keys(BUILDERS) : arg.split(",").map((s) => s.trim());

  for (const target of targets) {
    const fn = BUILDERS[target];
    if (!fn) {
      console.error(`Unknown country: ${target}`);
      process.exit(1);
    }
    try {
      await fn();
    } catch (err) {
      console.error(`[${target}] FAILED: ${err.message}`);
      process.exit(2);
    }
  }
}

main();
