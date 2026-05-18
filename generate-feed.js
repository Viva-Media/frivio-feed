/**
 * Vehicle Catalog Feed Generator for Frivio.se
 *
 * Source: https://backend.frivio.se/vehicles (auctions for motorhomes, caravans, boats)
 * Outputs:
 *   output/feed.csv  - CSV catalog
 *   output/feed.xml  - RSS 2.0 XML feed (Google/Facebook style + Frivio auction extensions)
 *
 * Required fields per spec:
 *   vehicle_id, title, description, url, image[0].url, make, model, year,
 *   mileage.value, mileage.unit, price, address, condition
 *
 * Auction extensions:
 *   auction_end_date, auction_ends_within_7_days, current_bid,
 *   reserve_price_status, monthly_cost, body_style, fuel_type
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://backend.frivio.se/vehicles?items=500';
const VEHICLE_DETAIL_URL = (id) => `https://backend.frivio.se/vehicle/${id}`;
const SITE_BASE = 'https://frivio.se';
const IMAGE_BASE = 'https://backend.frivio.se/vehicle';
const OUTPUT_DIR = path.join(__dirname, 'output');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (frivio-feed-generator)',
        'Origin': 'https://frivio.se',
        'Referer': 'https://frivio.se/'
      }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchAllVehicles() {
  console.log(`Fetching vehicle list: ${API_URL}`);
  const list = await fetchJson(API_URL);
  if (!Array.isArray(list)) throw new Error('Vehicle list response is not an array');
  console.log(`Fetched ${list.length} vehicles`);
  return list;
}

async function fetchVehicleDetails(vehicles) {
  console.log(`Fetching detail for ${vehicles.length} vehicles (descriptions)...`);
  const details = new Map();
  // Sequential to avoid overwhelming the backend (only ~50 items)
  for (const v of vehicles) {
    try {
      const d = await fetchJson(VEHICLE_DETAIL_URL(v.id));
      details.set(v.id, d);
    } catch (e) {
      console.warn(`Skipped detail for ${v.id}: ${e.message}`);
      details.set(v.id, null);
    }
  }
  return details;
}

/* ---------- Field mapping helpers ---------- */

// Meta Commerce Manager (Vehicles) enum values. The catalog ingestor rejects rows
// that don't match these enums, so we map every Frivio value to a valid one and
// fall back to OTHER/NONE when there is no direct equivalent.

function mapBodyStyle(category) {
  // Allowed: CONVERTIBLE, COUPE, CROSSOVER, ESTATE, GRANDTOURER, HATCHBACK,
  // MINIBUS, MINIVAN, MPV, PICKUP, ROADSTER, SALOON, SEDAN, SMALL_CAR,
  // SPORTSCAR, SUPERCAR, SUPERMINI, SUV, TRUCK, VAN, WAGON, OTHER, NONE.
  // Frivio sells Husbil (motorhome) / Husvagn (caravan) / Båt (boat) — none of
  // which have a direct car-body equivalent. Use VAN for husbil and OTHER for
  // the rest. Real category is preserved in the body_type_label field.
  const m = { 'Husbil': 'VAN', 'Husvagn': 'OTHER', 'Båt': 'OTHER' };
  return m[category] || 'OTHER';
}

function mapFuelType(fuel) {
  // Allowed: DIESEL, ELECTRIC, FLEX, GASOLINE, GASOLINE_AND_NATURAL_GAS,
  // GASOLINE_AND_PROPANE, HYBRID, HYDROGEN, NATURAL_GAS, PLUG_IN_HYBRID,
  // PROPANE, NONE, OTHER.
  if (!fuel) return 'NONE';
  const m = {
    'Bensin': 'GASOLINE',
    'Diesel': 'DIESEL',
    'El': 'ELECTRIC',
    'Elektrisk': 'ELECTRIC',
    'Elhybrid': 'HYBRID',
    'Hybrid': 'HYBRID',
    'Laddhybrid': 'PLUG_IN_HYBRID',
    'Gas': 'NATURAL_GAS',
    'Etanol': 'FLEX'
  };
  return m[fuel] || 'OTHER';
}

function mapCondition(cond) {
  // Allowed: EXCELLENT, VERY_GOOD, GOOD, FAIR, POOR, OTHER.
  // Frivio only exposes "Nytt" / "Begagnat", so we map them to a sensible default.
  if (!cond) return 'GOOD';
  return cond.toLowerCase().startsWith('ny') ? 'EXCELLENT' : 'GOOD';
}

function mapStateOfVehicle(cond) {
  // Allowed: NEW, USED, CPO.
  if (!cond) return 'USED';
  return cond.toLowerCase().startsWith('ny') ? 'NEW' : 'USED';
}

function mapTransmission(g) {
  // Meta: AUTOMATIC | MANUAL | OTHER. Frivio uses "Automat"/"Automatisk"/"Manuell".
  if (!g) return '';
  const s = g.toLowerCase();
  if (s.startsWith('aut')) return 'AUTOMATIC';
  if (s.startsWith('man')) return 'MANUAL';
  return 'OTHER';
}

// Meta vehicle region needs to be a Swedish length string. The Frivio API gives
// us a region (e.g. "Jönköping"). For Meta we map the common Swedish counties
// to recognisable values; everything else flows through unchanged.
function getRegion(v) {
  return v.region || '';
}

function getMake(v) {
  // Required by Meta. Boats often have brand=null in the Frivio API, so fall
  // back to the first word of the title (which is usually the manufacturer)
  // and only use a generic placeholder as last resort.
  if (v.brand) return v.brand;
  if (v.title) {
    const first = v.title.trim().split(/\s+/)[0];
    if (first && first.length >= 2) return first;
  }
  return 'Övrigt';
}

function buildTitle(v) {
  const parts = [];
  if (v.brand) parts.push(v.brand);
  if (v.title) parts.push(v.title);
  return parts.join(' ').trim().substring(0, 200);
}

function buildDescription(v, detail) {
  const sentences = [];
  if (detail?.description) {
    sentences.push(detail.description.replace(/\s+/g, ' ').trim());
  } else {
    const t = buildTitle(v);
    if (t) sentences.push(t);
  }
  const facts = [];
  if (v.year) facts.push(`Årsmodell: ${v.year}`);
  if (v.vehicle_category) facts.push(`Typ: ${v.vehicle_category}`);
  if (v.fuel) facts.push(`Drivmedel: ${v.fuel}`);
  if (v.gearbox) facts.push(`Växellåda: ${v.gearbox}`);
  if (v.mileage && v.mileage > 0) facts.push(`Mätarställning: ${v.mileage.toLocaleString('sv-SE')} mil`);
  if (v.city) facts.push(`Ort: ${v.city}`);
  if (facts.length) sentences.push(facts.join(' · '));
  return sentences.join(' ').substring(0, 5000);
}

function getPrimaryImage(v) {
  if (!v.photos || !v.photos.length) return '';
  return `${IMAGE_BASE}/${v.id}/${v.photos[0]}`;
}

function getPrice(v) {
  // For auctions: use current_price (current bid). For fixed-price: fixed_price.
  // If neither, fall back to starting_price.
  return v.current_price || v.fixed_price || v.starting_price || 0;
}

function isAuction(v) {
  return v.auction === true && (v.fixed_price === null || v.fixed_price === undefined);
}

function getAuctionEndIso(v) {
  if (!v.auction_end) return '';
  return new Date(v.auction_end).toISOString();
}

// Human-readable Swedish auction end label, e.g. "Slutar 2026-05-18 14:42".
function getAuctionEndLabel(v) {
  if (!v.auction_end) return '';
  const d = new Date(v.auction_end);
  const pad = (n) => String(n).padStart(2, '0');
  return `Slutar ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function endsWithinDays(v, days) {
  if (!v.auction_end) return false;
  const diff = v.auction_end - Date.now();
  return diff > 0 && diff <= days * 24 * 3600 * 1000;
}

function getReservePriceStatus(v) {
  // Frivio's `reservations_pris` boolean is true when the reserve price has been met.
  // Vehicles without a reserve price are also reported as false in the API, so we
  // describe it as a binary "met / not met" with a neutral fallback when there are no bids.
  if (v.fixed_price) return 'Ej tillämpligt (fast pris)';
  if (!v.bid_count || v.bid_count === 0) return 'Inga bud lagda';
  return v.reservations_pris === true ? 'Reservationspris uppnått' : 'Reservationspris ej uppnått';
}

// Annuitetslån-baserad månadskostnad (Frivio finansiering: schablon 60 mån, 6,95 %, 20 % kontant)
function calculateMonthlyCost(price) {
  if (!price || price <= 0) return null;
  const downPaymentRate = 0.20;
  const annualRate = 0.0695;
  const months = 60;
  const loan = price * (1 - downPaymentRate);
  const r = annualRate / 12;
  const m = loan * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  return Math.round(m);
}

function getVehicleUrl(v) {
  return `${SITE_BASE}/auktion/${v.id}`;
}

/* ---------- Output: CSV ---------- */

function escapeCsv(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes(';')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function generateCSV(vehicles, details) {
  const headers = [
    // Required
    'vehicle_id', 'title', 'description', 'url', 'image[0].url', 'image[0].tag',
    'make', 'model', 'year',
    'mileage.value', 'mileage.unit',
    'price', 'condition',
    // Address (Meta requires the structured form; a plain "address" column
    // containing a city string is rejected as malformed).
    'address.addr1', 'address.city', 'address.region', 'address.country',
    // Auction extensions
    'auction_end_date', 'auction_ends_within_7_days',
    'current_bid', 'reserve_price_status',
    'monthly_cost', 'body_style', 'body_type_label', 'fuel_type', 'transmission',
    // Extra useful fields
    'state_of_vehicle', 'availability', 'currency',
    'starting_price', 'fixed_price', 'bid_count', 'listing_type',
    // Meta custom labels — picked up automatically without manual mapping.
    // 0 = vehicle type in Swedish (Husbil/Husvagn/Båt) so Malin can filter on
    // the real category instead of the generic Meta body_style enum (VAN/OTHER).
    // 1 = human-readable auction end timestamp.
    'custom_label_0', 'custom_label_1'
  ];

  let rows = [headers.join(',')];
  let included = 0, skipped = 0;

  for (const v of vehicles) {
    if (!v.id || !v.title) { skipped++; continue; }
    const detail = details.get(v.id);
    const price = getPrice(v);
    if (!price) { skipped++; continue; }

    const isBoatOrCaravan = v.vehicle_category === 'Båt' || v.vehicle_category === 'Husvagn';
    const mileageKm = isBoatOrCaravan ? 0 : (v.mileage || 0) * 10; // Frivio stores mil; spec says KM, boats/caravans = 0

    const monthly = calculateMonthlyCost(price);

    const row = [
      escapeCsv(v.id),
      escapeCsv(buildTitle(v)),
      escapeCsv(buildDescription(v, detail)),
      escapeCsv(getVehicleUrl(v)),
      escapeCsv(getPrimaryImage(v)),
      escapeCsv('["Exterior"]'),
      escapeCsv(getMake(v)),
      escapeCsv(v.title || ''),
      escapeCsv(v.year || ''),
      escapeCsv(mileageKm),
      escapeCsv('KM'),
      escapeCsv(`${price} SEK`),
      escapeCsv(mapCondition(v.condition)),
      escapeCsv(v.city || ''),
      escapeCsv(v.city || ''),
      escapeCsv(getRegion(v)),
      escapeCsv('SE'),
      escapeCsv(getAuctionEndIso(v)),
      escapeCsv(endsWithinDays(v, 7) ? 'true' : 'false'),
      escapeCsv(v.current_price || ''),
      escapeCsv(getReservePriceStatus(v)),
      escapeCsv(monthly ? `${monthly} kr/mån` : ''),
      escapeCsv(mapBodyStyle(v.vehicle_category)),
      escapeCsv(v.vehicle_category || ''),
      escapeCsv(mapFuelType(v.fuel)),
      escapeCsv(mapTransmission(v.gearbox)),
      escapeCsv(mapStateOfVehicle(v.condition)),
      escapeCsv('AVAILABLE'),
      escapeCsv('SEK'),
      escapeCsv(v.starting_price || ''),
      escapeCsv(v.fixed_price || ''),
      escapeCsv(v.bid_count || 0),
      escapeCsv(isAuction(v) ? 'auction' : 'fixed_price'),
      escapeCsv(v.vehicle_category || ''),
      escapeCsv(getAuctionEndLabel(v))
    ];
    rows.push(row.join(','));
    included++;
  }

  return { csv: rows.join('\n') + '\n', included, skipped };
}

/* ---------- Output: XML (RSS 2.0 with Google Merchant + Frivio auction extensions) ---------- */

function escapeXml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateXML(vehicles, details) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0" xmlns:frivio="https://frivio.se/feed/ns/1.0">');
  lines.push('  <channel>');
  lines.push('    <title>Frivio - Fritidsfordon på nätet</title>');
  lines.push(`    <link>${SITE_BASE}</link>`);
  lines.push('    <description>Auktioner och fastpris-annonser på husbilar, husvagnar och båtar</description>');
  lines.push(`    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`);

  let included = 0, skipped = 0;

  for (const v of vehicles) {
    if (!v.id || !v.title) { skipped++; continue; }
    const detail = details.get(v.id);
    const price = getPrice(v);
    if (!price) { skipped++; continue; }

    const isBoatOrCaravan = v.vehicle_category === 'Båt' || v.vehicle_category === 'Husvagn';
    const mileageKm = isBoatOrCaravan ? 0 : (v.mileage || 0) * 10;
    const monthly = calculateMonthlyCost(price);
    const image = getPrimaryImage(v);
    const url = getVehicleUrl(v);

    lines.push('    <item>');
    lines.push(`      <vehicle_id>${escapeXml(v.id)}</vehicle_id>`);
    lines.push(`      <g:id>${escapeXml(v.id)}</g:id>`);
    lines.push(`      <title>${escapeXml(buildTitle(v))}</title>`);
    lines.push(`      <description>${escapeXml(buildDescription(v, detail))}</description>`);
    lines.push(`      <url>${escapeXml(url)}</url>`);
    lines.push(`      <g:link>${escapeXml(url)}</g:link>`);

    if (image) {
      lines.push('      <image>');
      lines.push(`        <url>${escapeXml(image)}</url>`);
      lines.push('        <tag>Exterior</tag>');
      lines.push('      </image>');
      lines.push(`      <g:image_link>${escapeXml(image)}</g:image_link>`);
    }

    // All photos as additional images
    if (v.photos && v.photos.length > 1) {
      for (const p of v.photos.slice(1, 11)) {
        lines.push(`      <g:additional_image_link>${escapeXml(`${IMAGE_BASE}/${v.id}/${p}`)}</g:additional_image_link>`);
      }
    }

    lines.push(`      <make>${escapeXml(getMake(v))}</make>`);
    lines.push(`      <model>${escapeXml(v.title)}</model>`);
    if (v.year) lines.push(`      <year>${v.year}</year>`);

    lines.push('      <mileage>');
    lines.push(`        <value>${mileageKm}</value>`);
    lines.push('        <unit>KM</unit>');
    lines.push('      </mileage>');

    lines.push(`      <price>${price} SEK</price>`);
    lines.push(`      <g:price>${price} SEK</g:price>`);

    lines.push(`      <address>${escapeXml(v.city || '')}</address>`);
    lines.push('      <address format="simple">');
    lines.push(`        <component name="addr1">${escapeXml(v.city || '')}</component>`);
    lines.push(`        <component name="city">${escapeXml(v.city || '')}</component>`);
    lines.push(`        <component name="region">${escapeXml(getRegion(v))}</component>`);
    lines.push('        <component name="country">SE</component>');
    lines.push('      </address>');
    lines.push(`      <condition>${mapCondition(v.condition)}</condition>`);
    lines.push(`      <state_of_vehicle>${mapStateOfVehicle(v.condition)}</state_of_vehicle>`);
    const transmission = mapTransmission(v.gearbox);
    if (transmission) lines.push(`      <transmission>${transmission}</transmission>`);

    // Auction-specific extensions (Frivio namespace)
    lines.push(`      <frivio:listing_type>${isAuction(v) ? 'auction' : 'fixed_price'}</frivio:listing_type>`);
    if (v.auction_end) {
      lines.push(`      <frivio:auction_end_date>${escapeXml(getAuctionEndIso(v))}</frivio:auction_end_date>`);
      lines.push(`      <frivio:auction_ends_within_7_days>${endsWithinDays(v, 7) ? 'true' : 'false'}</frivio:auction_ends_within_7_days>`);
    }
    if (v.current_price) {
      lines.push(`      <frivio:current_bid>${v.current_price} SEK</frivio:current_bid>`);
    }
    if (v.bid_count !== undefined) {
      lines.push(`      <frivio:bid_count>${v.bid_count}</frivio:bid_count>`);
    }
    lines.push(`      <frivio:reserve_price_status>${escapeXml(getReservePriceStatus(v))}</frivio:reserve_price_status>`);
    if (monthly) {
      lines.push(`      <frivio:monthly_cost>${monthly} kr/mån</frivio:monthly_cost>`);
    }
    lines.push(`      <body_style>${escapeXml(mapBodyStyle(v.vehicle_category))}</body_style>`);
    if (v.vehicle_category) lines.push(`      <frivio:body_type_label>${escapeXml(v.vehicle_category)}</frivio:body_type_label>`);
    lines.push(`      <fuel_type>${escapeXml(mapFuelType(v.fuel))}</fuel_type>`);
    if (v.region) lines.push(`      <frivio:region>${escapeXml(v.region)}</frivio:region>`);

    lines.push('      <availability>AVAILABLE</availability>');
    if (v.vehicle_category) lines.push(`      <custom_label_0>${escapeXml(v.vehicle_category)}</custom_label_0>`);
    const endLabel = getAuctionEndLabel(v);
    if (endLabel) lines.push(`      <custom_label_1>${escapeXml(endLabel)}</custom_label_1>`);
    lines.push('    </item>');
    included++;
  }

  lines.push('  </channel>');
  lines.push('</rss>');
  return { xml: lines.join('\n'), included, skipped };
}

/* ---------- Main ---------- */

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const vehicles = await fetchAllVehicles();
  const details = await fetchVehicleDetails(vehicles);

  const csv = generateCSV(vehicles, details);
  const csvPath = path.join(OUTPUT_DIR, 'feed.csv');
  fs.writeFileSync(csvPath, '﻿' + csv.csv, 'utf8'); // BOM for Excel
  console.log(`CSV: ${csvPath} (${csv.included} included, ${csv.skipped} skipped, ${(csv.csv.length / 1024).toFixed(1)} KB)`);

  const xml = generateXML(vehicles, details);
  const xmlPath = path.join(OUTPUT_DIR, 'feed.xml');
  fs.writeFileSync(xmlPath, xml.xml, 'utf8');
  console.log(`XML: ${xmlPath} (${xml.included} included, ${xml.skipped} skipped, ${(xml.xml.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error('Feed generation failed:', e.message);
  process.exit(1);
});
