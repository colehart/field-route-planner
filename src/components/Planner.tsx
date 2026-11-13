'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatClock, formatDuration, haversineKm } from '@/lib/geo';
import { DEFAULT_SETTINGS, HUBS, TECHNICIANS, TOWNS, createUrgentJob, generateJobs } from '@/lib/scenario';
import { planRoutes } from '@/lib/solver';
import { THEMES } from '@/lib/theme';
import type { Job, LngLat, Plan, PlannerSettings, Priority, Route } from '@/lib/types';
import { usePrefersDark } from './usePrefersDark';
import styles from './Planner.module.css';

const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => <div className={styles.mapLoading}>Loading map…</div>,
});

const PRIORITY_LABEL: Record<Priority, string> = { 1: 'Urgent', 2: 'High', 3: 'Routine' };

function nearestTown(position: LngLat): string {
  let best = TOWNS[0];
  let bestKm = Infinity;
  for (const town of TOWNS) {
    const km = haversineKm(position, [town.lon, town.lat]);
    if (km < bestKm) {
      best = town;
      bestKm = km;
    }
  }
  return bestKm < 8 ? best.name : `near ${best.name}`;
}

function pctChange(next: number, prev: number): number | null {
  if (!prev) return null;
  return (next - prev) / prev;
}

export default function Planner() {
  const dark = usePrefersDark();
  const theme = THEMES[dark ? 'dark' : 'light'];

  const [seed, setSeed] = useState(7);
  const [jobCount, setJobCount] = useState(45);
  const [shiftHours, setShiftHours] = useState(DEFAULT_SETTINGS.shiftMin / 60);
  const [onShift, setOnShift] = useState<Set<string>>(() => new Set(TECHNICIANS.map((t) => t.id)));
  const [urgentJobs, setUrgentJobs] = useState<Job[]>([]);
  const [strategy, setStrategy] = useState<Plan['strategy']>('optimized');
  const [selectedTech, setSelectedTech] = useState<string | null>(null);
  const [placingUrgent, setPlacingUrgent] = useState(false);
  const [rawClock, setClock] = useState(DEFAULT_SETTINGS.dayStartMin + 3 * 60);
  const [playing, setPlaying] = useState(false);

  const settings: PlannerSettings = useMemo(() => ({ ...DEFAULT_SETTINGS, shiftMin: shiftHours * 60 }), [shiftHours]);
  const jobs = useMemo(() => [...generateJobs(jobCount, seed), ...urgentJobs], [jobCount, seed, urgentJobs]);
  const technicians = useMemo(() => TECHNICIANS.filter((t) => onShift.has(t.id)), [onShift]);

  const plans = useMemo(() => {
    const input = { hubs: HUBS, technicians, jobs, settings };
    return { optimized: planRoutes(input, 'optimized'), baseline: planRoutes(input, 'baseline') };
  }, [technicians, jobs, settings]);
  const plan = plans[strategy];
  const other = plans[strategy === 'optimized' ? 'baseline' : 'optimized'];

  const dayStart = settings.dayStartMin;
  const dayEnd = dayStart + settings.shiftMin;
  const clock = Math.min(Math.max(rawClock, dayStart), dayEnd);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setClock((c) => {
        const next = c + dt * 30; // 30 simulated minutes per second
        return next > dayEnd ? dayStart : next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, dayStart, dayEnd]);

  const handleMapClick = useCallback(
    (position: LngLat) => {
      if (!placingUrgent) return;
      setUrgentJobs((prev) => [...prev, createUrgentJob(position, prev.length, nearestTown(position))]);
      setPlacingUrgent(false);
    },
    [placingUrgent],
  );

  const toggleTech = (id: string) =>
    setOnShift((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const routeByTech = useMemo(() => new Map(plan.routes.map((r) => [r.technicianId, r])), [plan]);
  const m = plan.metrics;
  const o = other.metrics;
  const comparing = strategy === 'optimized' ? 'vs first-come' : 'vs optimized';

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <header className={styles.header}>
          <h1>Field Route Planner</h1>
          <p>
            One day of field service across Colorado’s Front Range and plains: {jobs.length} service calls,{' '}
            {technicians.length} technicians, four hubs.
          </p>
        </header>

        <div className={styles.segmented} role="tablist" aria-label="Dispatch strategy">
          {(['optimized', 'baseline'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={strategy === s} className={strategy === s ? styles.segOn : ''} onClick={() => setStrategy(s)}>
              {s === 'optimized' ? 'Optimized routes' : 'First-come dispatch'}
            </button>
          ))}
        </div>
        <p className={styles.hint}>
          {strategy === 'optimized'
            ? 'Savings construction, priority-first insertion, then 2-opt, relocate and swap moves across all hubs.'
            : 'How a busy dispatcher works by hand: calls in arrival order, each to the nearest hub’s least-busy tech.'}
        </p>

        <section className={styles.kpis} aria-label="Plan metrics">
          <Kpi label="Jobs served" value={`${m.jobsServed}`} unit={`of ${m.jobsTotal}`} delta={m.jobsServed - o.jobsServed} deltaUnit="jobs" comparing={comparing} higherIsBetter />
          <Kpi label="Urgent served" value={`${m.urgentServed}`} unit={`of ${m.urgentTotal}`} delta={m.urgentServed - o.urgentServed} deltaUnit="urgent" comparing={comparing} higherIsBetter />
          <Kpi label="Drive per job" value={formatDuration(m.driveMinPerJob)} pct={pctChange(m.driveMinPerJob, o.driveMinPerJob)} comparing={comparing} />
          <Kpi label={`Total driving · ${formatDuration(m.driveMin)}`} value={`${Math.round(m.distanceKm).toLocaleString()} km`} pct={pctChange(m.distanceKm, o.distanceKm)} comparing={comparing} />
        </section>

        <section className={styles.section}>
          <h2>Scenario</h2>
          <label className={styles.slider}>
            <span>
              Service calls <strong>{jobCount}</strong>
            </span>
            <input type="range" min={15} max={100} step={5} value={jobCount} onChange={(e) => setJobCount(Number(e.target.value))} />
          </label>
          <label className={styles.slider}>
            <span>
              Shift length <strong>{shiftHours} h</strong>
            </span>
            <input type="range" min={6} max={12} step={0.5} value={shiftHours} onChange={(e) => setShiftHours(Number(e.target.value))} />
          </label>
          <div className={styles.buttonRow}>
            <button
              className={styles.button}
              onClick={() => {
                setSeed((s) => s + 1);
                setUrgentJobs([]);
                setSelectedTech(null);
              }}
            >
              New day
            </button>
            <button className={`${styles.button} ${placingUrgent ? styles.buttonActive : ''}`} aria-pressed={placingUrgent} onClick={() => setPlacingUrgent((v) => !v)}>
              {placingUrgent ? 'Click the map…' : 'Add urgent call'}
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Crew</h2>
          <ul className={styles.crew}>
            {TECHNICIANS.map((tech) => {
              const route = routeByTech.get(tech.id);
              const active = onShift.has(tech.id);
              const selected = selectedTech === tech.id;
              const hub = HUBS.find((h) => h.id === tech.hubId)!;
              return (
                <li key={tech.id} className={`${styles.techRow} ${selected ? styles.techSelected : ''} ${active ? '' : styles.techOff}`}>
                  <div className={styles.techHead}>
                    <input type="checkbox" checked={active} onChange={() => toggleTech(tech.id)} aria-label={`${tech.name} on shift`} />
                    <button className={styles.techName} onClick={() => setSelectedTech(selected ? null : tech.id)} disabled={!active} aria-expanded={selected}>
                      <span className={styles.swatch} style={{ background: theme.routeHex[tech.colorSlot] }} aria-hidden />
                      <span>
                        {tech.name}
                        <small>{hub.name}</small>
                      </span>
                    </button>
                    <span className={styles.techStats}>{active && route ? `${route.stops.length} stops · ${formatDuration(route.driveMin)} driving` : 'Off shift'}</span>
                  </div>
                  {active && route && <Utilization route={route} shiftMin={settings.shiftMin} />}
                  {selected && route && <Itinerary route={route} jobsById={jobsById} />}
                </li>
              );
            })}
          </ul>
        </section>

        {plan.unassignedJobIds.length > 0 && (
          <section className={styles.section}>
            <details>
              <summary>
                <h2>Not scheduled today ({plan.unassignedJobIds.length})</h2>
              </summary>
              <ul className={styles.unassigned}>
                {plan.unassignedJobIds
                  .map((id) => jobsById.get(id)!)
                  .sort((a, b) => a.priority - b.priority)
                  .map((job) => (
                    <li key={job.id}>
                      <PriorityBadge priority={job.priority} /> {job.workType}, {job.town}
                    </li>
                  ))}
              </ul>
            </details>
          </section>
        )}

        <footer className={styles.footer}>
          <p>
            Places from GeoNames (CC BY 4.0), basemap from Natural Earth and the US Census Bureau. Service calls and crew are synthetic. Travel times use
            straight-line distance × {settings.circuity} at {settings.speedKmh} km/h.
          </p>
          <p>
            <a href="https://github.com/colehart/field-route-planner">Source on GitHub</a>
          </p>
        </footer>
      </aside>

      <main className={`${styles.mapArea} ${placingUrgent ? styles.placing : ''}`}>
        <MapView
          theme={theme}
          hubs={HUBS}
          technicians={TECHNICIANS}
          jobs={jobs}
          plan={plan}
          selectedTech={selectedTech}
          clock={clock}
          settings={settings}
          onSelectTech={setSelectedTech}
          onMapClick={handleMapClick}
        />
        <div className={styles.timebar}>
          <button className={styles.play} onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play the day'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <input
            type="range"
            min={dayStart}
            max={dayEnd}
            step={1}
            value={clock}
            onChange={(e) => {
              setPlaying(false);
              setClock(Number(e.target.value));
            }}
            aria-label="Time of day"
          />
          <span className={styles.clock}>{formatClock(clock)}</span>
        </div>
        <Legend />
      </main>
    </div>
  );
}

function Kpi(props: {
  label: string;
  value: string;
  unit?: string;
  delta?: number;
  deltaUnit?: string;
  pct?: number | null;
  comparing: string;
  higherIsBetter?: boolean;
}) {
  const { label, value, unit, delta, deltaUnit, pct, comparing, higherIsBetter } = props;
  const change = pct ?? delta ?? 0;
  const good = higherIsBetter ? change > 0 : change < 0;
  const text =
    pct != null
      ? `${pct > 0 ? '+' : ''}${Math.round(pct * 100)}% ${comparing}`
      : delta != null
        ? `${delta > 0 ? '+' : ''}${delta} ${deltaUnit} ${comparing}`
        : '';
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue}>
        {value} {unit && <small>{unit}</small>}
      </span>
      {Math.abs(change) > 0.0049 ? (
        <span className={`${styles.kpiDelta} ${good ? styles.good : styles.bad}`}>
          <span aria-hidden>{good ? '▲' : '▼'}</span> {text}
        </span>
      ) : (
        <span className={styles.kpiDelta}>No change {comparing}</span>
      )}
    </div>
  );
}

function Utilization({ route, shiftMin }: { route: Route; shiftMin: number }) {
  const drive = (route.driveMin / shiftMin) * 100;
  const work = (route.serviceMin / shiftMin) * 100;
  return (
    <div className={styles.util} title={`${formatDuration(route.serviceMin)} on site, ${formatDuration(route.driveMin)} driving`}>
      <span className={styles.utilWork} style={{ width: `${work}%` }} />
      <span className={styles.utilDrive} style={{ width: `${drive}%` }} />
    </div>
  );
}

function Itinerary({ route, jobsById }: { route: Route; jobsById: Map<string, Job> }) {
  return (
    <ol className={styles.itinerary}>
      {route.stops.map((stop) => {
        const job = jobsById.get(stop.jobId)!;
        return (
          <li key={stop.jobId}>
            <time>{formatClock(stop.arriveMin)}</time>
            <span>
              <PriorityBadge priority={job.priority} /> {job.workType}
              <small>
                {job.customer}, {job.town} · {job.serviceMin} min on site
              </small>
            </span>
          </li>
        );
      })}
      <li>
        <time>{formatClock(route.endMin)}</time>
        <span>Back at hub</span>
      </li>
    </ol>
  );
}

function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`${styles.badge} ${styles[`p${priority}`]}`}>{PRIORITY_LABEL[priority]}</span>;
}

function Legend() {
  return (
    <div className={styles.legend} aria-label="Map legend">
      <span>
        <i className={styles.legendHub} /> Hub
      </span>
      <span>
        <i className={styles.legendUrgent} /> Urgent call
      </span>
      <span>
        <i className={styles.legendJob} /> Scheduled call
      </span>
      <span>
        <i className={styles.legendUnassigned} /> Not scheduled
      </span>
      <span>
        <i className={styles.legendTech} /> Technician now
      </span>
    </div>
  );
}
