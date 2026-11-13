'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map, NavigationControl, AttributionControl, useControl, type MapRef } from 'react-map-gl/maplibre';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { PickingInfo } from '@deck.gl/core';
import type { StyleSpecification } from 'maplibre-gl';
import { formatClock, haversineKm } from '@/lib/geo';
import { TOWNS } from '@/lib/scenario';
import type { MapTheme } from '@/lib/theme';
import type { Hub, Job, LngLat, Plan, PlannerSettings, Technician } from '@/lib/types';
import styles from './Planner.module.css';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const STREET_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const SERVICE_BOUNDS: [LngLat, LngLat] = [
  [-105.75, 38.2],
  [-102.55, 41.05],
];

type Basemap = 'streets' | 'offline';

interface Props {
  theme: MapTheme;
  hubs: Hub[];
  technicians: Technician[];
  jobs: Job[];
  plan: Plan;
  selectedTech: string | null;
  clock: number;
  settings: PlannerSettings;
  onSelectTech: (id: string | null) => void;
  onMapClick: (position: LngLat) => void;
}

interface Trip {
  techId: string;
  color: [number, number, number];
  path: LngLat[];
  timestamps: number[];
}

interface JobPoint {
  job: Job;
  techId: string | null;
  color: [number, number, number] | null;
  arriveMin: number | null;
  departMin: number | null;
}

type BasemapData = Record<'colorado' | 'counties' | 'states' | 'urban' | 'lakes' | 'rivers' | 'roads', GeoJSON.FeatureCollection>;

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

/** A self-contained MapLibre style built from the bundled basemap data: no tile server or API key needed. */
function offlineStyle(theme: MapTheme, data: BasemapData | null): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': theme.outside } }],
  };
  if (!data) return style;
  for (const key of Object.keys(data) as (keyof BasemapData)[]) {
    style.sources[key] = { type: 'geojson', data: data[key] };
  }
  style.layers.push(
    { id: 'colorado', type: 'fill', source: 'colorado', paint: { 'fill-color': theme.land } },
    { id: 'urban', type: 'fill', source: 'urban', paint: { 'fill-color': theme.urban } },
    { id: 'lakes', type: 'fill', source: 'lakes', paint: { 'fill-color': theme.water } },
    { id: 'rivers', type: 'line', source: 'rivers', paint: { 'line-color': theme.water, 'line-width': 1.2 } },
    { id: 'counties', type: 'line', source: 'counties', paint: { 'line-color': theme.county, 'line-width': 0.8 } },
    { id: 'roads', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': theme.roadMajor, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 10, 3] } },
    { id: 'states', type: 'line', source: 'states', paint: { 'line-color': theme.boundary, 'line-width': 1.4, 'line-dasharray': [3, 2] } },
  );
  return style;
}

function positionAt(trip: Trip, clock: number): LngLat | null {
  const ts = trip.timestamps;
  if (ts.length < 2 || clock < ts[0] || clock > ts[ts.length - 1]) return null;
  for (let i = 1; i < ts.length; i++) {
    if (clock <= ts[i]) {
      const span = ts[i] - ts[i - 1];
      const f = span > 0 ? (clock - ts[i - 1]) / span : 0;
      const [a, b] = [trip.path[i - 1], trip.path[i]];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  return trip.path[trip.path.length - 1];
}

export default function MapView({ theme, hubs, technicians, jobs, plan, selectedTech, clock, settings, onSelectTech, onMapClick }: Props) {
  const mapRef = useRef<MapRef>(null);
  const [basemap, setBasemap] = useState<Basemap>('streets');
  const [basemapData, setBasemapData] = useState<BasemapData | null>(null);
  const [streetsFailed, setStreetsFailed] = useState(false);
  const styleLoaded = useRef(false);

  useEffect(() => {
    fetch(`${BASE_PATH}/data/basemap.json`)
      .then((r) => r.json())
      .then(setBasemapData)
      .catch(() => setBasemapData(null));
  }, []);

  const mapStyle = useMemo(
    () => (basemap === 'streets' && !streetsFailed ? STREET_STYLES[theme.mode] : offlineStyle(theme, basemapData)),
    [basemap, streetsFailed, theme, basemapData],
  );

  const techById = useMemo(() => new globalThis.Map(technicians.map((t) => [t.id, t])), [technicians]);
  const hubById = useMemo(() => new globalThis.Map(hubs.map((h) => [h.id, h])), [hubs]);
  const jobsById = useMemo(() => new globalThis.Map(jobs.map((j) => [j.id, j])), [jobs]);

  const trips: Trip[] = useMemo(
    () =>
      plan.routes
        .filter((r) => r.stops.length > 0)
        .map((route) => {
          const hub = hubById.get(route.hubId)!.position;
          const path: LngLat[] = [hub];
          const timestamps = [settings.dayStartMin];
          for (const stop of route.stops) {
            const pos = jobsById.get(stop.jobId)!.position;
            path.push(pos, pos);
            timestamps.push(stop.arriveMin, stop.departMin);
          }
          path.push(hub);
          timestamps.push(route.endMin);
          return { techId: route.technicianId, color: theme.route[techById.get(route.technicianId)!.colorSlot], path, timestamps };
        }),
    [plan, hubById, jobsById, techById, theme, settings.dayStartMin],
  );

  const jobPoints: JobPoint[] = useMemo(() => {
    const byJob = new globalThis.Map<string, { techId: string; arriveMin: number; departMin: number }>();
    for (const route of plan.routes) for (const s of route.stops) byJob.set(s.jobId, { techId: route.technicianId, arriveMin: s.arriveMin, departMin: s.departMin });
    return jobs
      .map((job) => {
        const a = byJob.get(job.id);
        return {
          job,
          techId: a?.techId ?? null,
          color: a ? theme.route[techById.get(a.techId)!.colorSlot] : null,
          arriveMin: a?.arriveMin ?? null,
          departMin: a?.departMin ?? null,
        };
      })
      .sort((a, b) => b.job.priority - a.job.priority); // urgent drawn last, on top
  }, [plan, jobs, theme, techById]);

  const techNow = useMemo(
    () => trips.map((trip) => ({ trip, position: positionAt(trip, clock) })).filter((t): t is { trip: Trip; position: LngLat } => t.position !== null),
    [trips, clock],
  );

  const dim = useCallback((techId: string | null, alpha = 255): number => (selectedTech && techId !== selectedTech ? 40 : alpha), [selectedTech]);

  const showLabels = basemap === 'offline' || streetsFailed;
  const labelTowns = useMemo(() => {
    // Greedy declutter: biggest towns first, skipping any within 25 km of a hub or a town already labeled.
    const placed: LngLat[] = hubs.map((h) => h.position);
    return TOWNS.filter((t) => {
      const pos: LngLat = [t.lon, t.lat];
      if (t.population < 3000 || placed.some((p) => haversineKm(p, pos) < 25)) return false;
      placed.push(pos);
      return true;
    });
  }, [hubs]);

  const layers = [
    showLabels &&
      new TextLayer({
        id: 'towns',
        data: labelTowns,
        getPosition: (t) => [t.lon, t.lat],
        getText: (t) => t.name,
        getSize: 11,
        getColor: [...theme.muted, 220],
        characterSet: 'auto',
        fontFamily: 'system-ui, sans-serif',
        fontSettings: { sdf: true },
        outlineWidth: 3,
        outlineColor: [...theme.surface, 200],
        updateTriggers: { getColor: theme.mode, outlineColor: theme.mode },
        getPixelOffset: [0, -10],
      }),
    new PathLayer<Trip>({
      id: 'route-casing',
      data: trips,
      getPath: (d) => d.path,
      getColor: [...theme.surface, 220],
      getWidth: 6,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      updateTriggers: { getColor: theme.mode },
    }),
    new PathLayer<Trip>({
      id: 'routes',
      data: trips,
      getPath: (d) => d.path,
      getColor: (d) => [...d.color, dim(d.techId, 150)],
      getWidth: 2.5,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 60],
      updateTriggers: { getColor: [selectedTech, theme.mode] },
    }),
    new TripsLayer<Trip>({
      id: 'trails',
      data: trips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: (d) => [...d.color, dim(d.techId)],
      currentTime: clock,
      trailLength: 75,
      fadeTrail: true,
      getWidth: 5,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      updateTriggers: { getColor: [selectedTech, theme.mode] },
    }),
    new ScatterplotLayer<JobPoint>({
      id: 'jobs',
      data: jobPoints,
      getPosition: (d) => d.job.position,
      getRadius: (d) => (d.job.priority === 1 ? 7 : 5),
      radiusUnits: 'pixels',
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (d) => (d.color ? 2 : 1.5),
      // Done jobs fill with the technician's color; upcoming ones are rings; unscheduled are gray.
      getFillColor: (d) => {
        if (!d.color) return [...theme.unassigned, dim(null, 110)];
        const done = d.departMin !== null && d.departMin <= clock;
        return done ? [...d.color, dim(d.techId)] : [...theme.surface, dim(d.techId)];
      },
      getLineColor: (d) => (d.color ? [...d.color, dim(d.techId)] : [...theme.surface, dim(null, 200)]),
      pickable: true,
      updateTriggers: { getFillColor: [clock, selectedTech, theme.mode], getLineColor: [selectedTech, theme.mode] },
    }),
    new ScatterplotLayer<{ trip: Trip; position: LngLat }>({
      id: 'technicians',
      data: techNow,
      getPosition: (d) => d.position,
      getRadius: 6,
      radiusUnits: 'pixels',
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 3,
      getFillColor: [...theme.surface, 255],
      getLineColor: (d) => [...d.trip.color, dim(d.trip.techId)],
      pickable: true,
      updateTriggers: { getLineColor: [selectedTech, theme.mode], getFillColor: theme.mode },
    }),
    new ScatterplotLayer<Hub>({
      id: 'hubs',
      data: hubs,
      getPosition: (d) => d.position,
      getRadius: 8,
      radiusUnits: 'pixels',
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2.5,
      getFillColor: [...theme.ink, 255],
      getLineColor: [...theme.surface, 255],
      pickable: true,
      updateTriggers: { getFillColor: theme.mode, getLineColor: theme.mode },
    }),
    new TextLayer<Hub>({
      id: 'hub-labels',
      data: hubs,
      getPosition: (d) => d.position,
      getText: (d) => d.name,
      getSize: 12,
      fontWeight: 600,
      getColor: [...theme.ink, 255],
      outlineWidth: 4,
      outlineColor: [...theme.surface, 230],
      fontSettings: { sdf: true },
      fontFamily: 'system-ui, sans-serif',
      getPixelOffset: [12, 0],
      getTextAnchor: 'start',
      updateTriggers: { getColor: theme.mode, outlineColor: theme.mode },
    }),
  ].filter(Boolean);

  const getTooltip = useCallback(
    ({ object, layer }: PickingInfo) => {
      if (!object || !layer) return null;
      const box = (html: string) => ({
        html,
        className: styles.tooltip,
        style: { background: `rgb(${theme.surface})`, color: `rgb(${theme.ink})` },
      });
      if (layer.id === 'jobs') {
        const d = object as JobPoint;
        const tech = d.techId ? techById.get(d.techId)?.name : null;
        const when = d.arriveMin !== null ? `${tech} · arrives ${formatClock(d.arriveMin)}` : 'Not scheduled today';
        const pr = ['', 'Urgent', 'High', 'Routine'][d.job.priority];
        return box(`<strong>${d.job.workType}</strong><br/>${d.job.customer}, ${d.job.town}<br/>${pr} · ${d.job.serviceMin} min on site<br/><em>${when}</em>`);
      }
      if (layer.id === 'routes' || layer.id === 'technicians') {
        const techId = layer.id === 'routes' ? (object as Trip).techId : (object as { trip: Trip }).trip.techId;
        const route = plan.routes.find((r) => r.technicianId === techId)!;
        return box(`<strong>${techById.get(techId)?.name}</strong><br/>${route.stops.length} stops · back at ${formatClock(route.endMin)}`);
      }
      if (layer.id === 'hubs') {
        const hub = object as Hub;
        const crew = technicians.filter((t) => t.hubId === hub.id).length;
        return box(`<strong>${hub.name} hub</strong><br/>${crew} technician${crew === 1 ? '' : 's'} on shift`);
      }
      return null;
    },
    [plan, techById, technicians, theme],
  );

  const onClick = useCallback(
    (info: PickingInfo) => {
      const obj = info.object as JobPoint | Trip | { trip: Trip } | undefined;
      if (obj && 'techId' in obj && obj.techId) return onSelectTech(obj.techId);
      if (obj && 'trip' in obj) return onSelectTech(obj.trip.techId);
      if (info.coordinate) onMapClick([info.coordinate[0], info.coordinate[1]]);
    },
    [onSelectTech, onMapClick],
  );

  return (
    <>
      <Map
        ref={mapRef}
        initialViewState={{ bounds: SERVICE_BOUNDS, fitBoundsOptions: { padding: 32 } }}
        mapStyle={mapStyle}
        minZoom={5}
        maxZoom={14}
        attributionControl={false}
        onLoad={() => (styleLoaded.current = true)}
        onError={() => {
          // A style that never loads (blocked network, tile host down) drops us to the bundled basemap.
          if (!styleLoaded.current && basemap === 'streets') setStreetsFailed(true);
        }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <DeckOverlay layers={layers} getTooltip={getTooltip} onClick={onClick} />
        <NavigationControl position="top-right" showCompass={false} />
        <AttributionControl
          key={basemap === 'streets' && !streetsFailed ? 'streets' : 'offline'}
          position="bottom-right"
          compact
          customAttribution={
            basemap === 'streets' && !streetsFailed
              ? '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              : 'Natural Earth · US Census Bureau · GeoNames'
          }
        />
      </Map>
      <div className={styles.basemapToggle} role="group" aria-label="Basemap">
        <button aria-pressed={basemap === 'streets' && !streetsFailed} onClick={() => setBasemap('streets')} disabled={streetsFailed} title={streetsFailed ? 'Street tiles could not load' : undefined}>
          Streets
        </button>
        <button aria-pressed={basemap === 'offline' || streetsFailed} onClick={() => setBasemap('offline')}>
          Offline
        </button>
      </div>
    </>
  );
}
