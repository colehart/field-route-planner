// Builds the static datasets the app ships with:
//   public/data/basemap.json  - offline basemap layers (Natural Earth + US Census via us-atlas)
//   src/data/towns.json       - populated places in the service area (GeoNames via all-the-cities)
//
// Usage: node scripts/build-data.mjs <dir-with-natural-earth-geojson>
// Download ne_10m_roads, ne_10m_urban_areas, ne_10m_lakes and
// ne_10m_rivers_lake_centerlines (.geojson) from
// https://github.com/nvkelso/natural-earth-vector/tree/master/geojson first.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { feature, mesh } from 'topojson-client';

const require = createRequire(import.meta.url);
const neDir = process.argv[2];
if (!neDir) {
  console.error('usage: node scripts/build-data.mjs <natural-earth-geojson-dir>');
  process.exit(1);
}

// Basemap extent (a little wider than Colorado so edges look natural).
const VIEW = [-110.5, 36.0, -100.5, 42.0];
// Service area for towns/jobs: the Front Range and northeastern plains.
const SERVICE = [-105.6, 38.25, -102.2, 41.0];

const inBox = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const round = (n) => Math.round(n * 1e4) / 1e4;
const roundCoords = (c) => (typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(roundCoords));

function bboxOf(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return b;
}
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function clipFeatures(file, keepProps) {
  const fc = JSON.parse(fs.readFileSync(path.join(neDir, file), 'utf8'));
  return fc.features
    .filter((f) => f.geometry && intersects(bboxOf(f.geometry), VIEW))
    .map((f) => ({
      type: 'Feature',
      properties: keepProps(f.properties),
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
    }));
}

const roads = clipFeatures('ne_10m_roads.geojson', (p) => ({
  kind: p.type === 'Major Highway' || /Interstate/i.test(p.label ?? '') ? 'major' : 'minor',
  label: p.label ?? null,
})).filter((f) => f.properties.kind === 'major' || f.properties.label);
const urban = clipFeatures('ne_10m_urban_areas.geojson', () => ({}));
const lakes = clipFeatures('ne_10m_lakes.geojson', (p) => ({ name: p.name ?? null }));
const rivers = clipFeatures('ne_10m_rivers_lake_centerlines.geojson', (p) => ({ name: p.name ?? null }));

const counties = require('us-atlas/counties-10m.json');
const colorado = (d) => String(d.id).startsWith('08');
const countyLines = mesh(counties, counties.objects.counties, (a, b) => a !== b && (colorado(a) || colorado(b)));
const stateLines = mesh(counties, counties.objects.states, (a, b) => a !== b);
const coloradoShape = feature(counties, counties.objects.states).features.find((f) => f.id === '08');

const fc = (features) => ({ type: 'FeatureCollection', features });
const basemap = {
  attribution: 'Natural Earth (public domain) · US Census Bureau via us-atlas · GeoNames (CC BY 4.0)',
  colorado: fc([{ type: 'Feature', properties: {}, geometry: { type: coloradoShape.geometry.type, coordinates: roundCoords(coloradoShape.geometry.coordinates) } }]),
  counties: fc([{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: roundCoords(countyLines.coordinates) } }]),
  states: fc([{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: roundCoords(stateLines.coordinates) } }]),
  urban: fc(urban),
  lakes: fc(lakes),
  rivers: fc(rivers),
  roads: fc(roads),
};
fs.writeFileSync('public/data/basemap.json', JSON.stringify(basemap));

const towns = require('all-the-cities')
  .filter((c) => c.country === 'US' && c.adminCode === 'CO' && inBox(c.loc.coordinates, SERVICE))
  .map((c) => ({ id: c.cityId, name: c.name, population: c.population, lon: round(c.loc.coordinates[0]), lat: round(c.loc.coordinates[1]) }))
  .sort((a, b) => b.population - a.population);
fs.mkdirSync('src/data', { recursive: true });
fs.writeFileSync('src/data/towns.json', JSON.stringify(towns, null, 0));

console.log(`towns: ${towns.length}, roads: ${roads.length}, urban: ${urban.length}, lakes: ${lakes.length}, rivers: ${rivers.length}`);
console.log(`basemap.json: ${(fs.statSync('public/data/basemap.json').size / 1024).toFixed(0)} KB`);
