import { haversineKm } from './geo';
import type { Hub, Job, Plan, PlanMetrics, PlannerSettings, Route, Stop, Technician } from './types';

/**
 * Multi-depot vehicle routing for one day of field service.
 *
 * Constraints: each technician starts and ends at their hub, and their drive time plus on-site
 * time must fit in one shift. Objective, in order: serve as many urgent (P1) jobs as possible,
 * then as many jobs as possible weighted by priority, then minimize total drive time.
 *
 * Travel time is straight-line distance times a road-circuity factor at an average speed, so the
 * demo needs no routing API. Swapping in a real road-network matrix (OSRM, Valhalla) only
 * changes `buildProblem`.
 */

export interface PlanInput {
  hubs: Hub[];
  technicians: Technician[];
  jobs: Job[];
  settings: PlannerSettings;
}

/** Priority weights used when deciding which jobs to serve first. */
const PRIORITY_WEIGHT = { 1: 100, 2: 10, 3: 1 } as const;

interface Problem {
  /** Node ids: hubs occupy 0..hubs.length-1, jobs follow. */
  nodeCount: number;
  hubCount: number;
  time: Float64Array;
  dist: Float64Array;
  service: Float64Array;
  weight: Float64Array;
  shift: number;
  input: PlanInput;
}

interface WorkRoute {
  tech: Technician;
  hub: number;
  seq: number[];
}

export function buildProblem(input: PlanInput): Problem {
  const { hubs, jobs, settings } = input;
  const points = [...hubs.map((h) => h.position), ...jobs.map((j) => j.position)];
  const n = points.length;
  const time = new Float64Array(n * n);
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const km = haversineKm(points[i], points[j]) * settings.circuity;
      const min = (km / settings.speedKmh) * 60;
      dist[i * n + j] = dist[j * n + i] = km;
      time[i * n + j] = time[j * n + i] = min;
    }
  }
  const service = new Float64Array(n);
  const weight = new Float64Array(n);
  jobs.forEach((job, k) => {
    service[hubs.length + k] = job.serviceMin;
    weight[hubs.length + k] = PRIORITY_WEIGHT[job.priority];
  });
  return { nodeCount: n, hubCount: hubs.length, time, dist, service, weight, shift: settings.shiftMin, input };
}

const t = (p: Problem, a: number, b: number) => p.time[a * p.nodeCount + b];

function driveOf(p: Problem, hub: number, seq: number[]): number {
  if (seq.length === 0) return 0;
  let total = t(p, hub, seq[0]) + t(p, seq[seq.length - 1], hub);
  for (let i = 1; i < seq.length; i++) total += t(p, seq[i - 1], seq[i]);
  return total;
}

function loadOf(p: Problem, hub: number, seq: number[]): number {
  let total = driveOf(p, hub, seq);
  for (const s of seq) total += p.service[s];
  return total;
}

const EPS = 1e-6;

/** Cost (extra minutes of shift used) of inserting `node` between positions i-1 and i. */
function insertionDelta(p: Problem, r: WorkRoute, node: number, i: number): number {
  const prev = i === 0 ? r.hub : r.seq[i - 1];
  const next = i === r.seq.length ? r.hub : r.seq[i];
  return t(p, prev, node) + t(p, node, next) - t(p, prev, next) + p.service[node];
}

function bestInsertion(p: Problem, r: WorkRoute, node: number, load: number): { pos: number; delta: number } | null {
  let best: { pos: number; delta: number } | null = null;
  for (let i = 0; i <= r.seq.length; i++) {
    const delta = insertionDelta(p, r, node, i);
    if (load + delta <= p.shift + EPS && (!best || delta < best.delta)) best = { pos: i, delta };
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Baseline: first-come, first-served dispatch
// ---------------------------------------------------------------------------------------------

/**
 * What a busy dispatcher does by hand: take requests in the order they arrive, send each to the
 * least-loaded technician at the nearest hub, and add it to the end of their day if it fits.
 */
function baselineRoutes(p: Problem): { routes: WorkRoute[]; unassigned: number[] } {
  const { hubs, technicians } = p.input;
  const routes: WorkRoute[] = technicians.map((tech) => ({ tech, hub: hubs.findIndex((h) => h.id === tech.hubId), seq: [] }));
  const unassigned: number[] = [];
  const order = p.input.jobs
    .map((job, k) => ({ job, node: p.hubCount + k }))
    .sort((a, b) => a.job.receivedOrder - b.job.receivedOrder);

  for (const { node } of order) {
    const hubsByDistance = [...new Set(routes.map((r) => r.hub))].sort((a, b) => t(p, a, node) - t(p, b, node));
    let placed = false;
    for (const hub of hubsByDistance.slice(0, 1)) {
      const candidates = routes.filter((r) => r.hub === hub).sort((a, b) => loadOf(p, a.hub, a.seq) - loadOf(p, b.hub, b.seq));
      for (const r of candidates) {
        if (loadOf(p, r.hub, r.seq) + insertionDelta(p, r, node, r.seq.length) <= p.shift + EPS) {
          r.seq.push(node);
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) unassigned.push(node);
  }
  return { routes, unassigned };
}

// ---------------------------------------------------------------------------------------------
// Optimized: savings construction + priority insertion + local search
// ---------------------------------------------------------------------------------------------

/** Clarke-Wright savings for the jobs assigned to one hub. Returns candidate routes (may exceed crew size). */
function savingsRoutes(p: Problem, hub: number, nodes: number[]): number[][] {
  const routeOf = new Map<number, number[]>();
  for (const n of nodes) routeOf.set(n, [n]);
  const savings: { i: number; j: number; s: number }[] = [];
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const i = nodes[a];
      const j = nodes[b];
      savings.push({ i, j, s: t(p, hub, i) + t(p, hub, j) - t(p, i, j) });
    }
  }
  savings.sort((x, y) => y.s - x.s);
  for (const { i, j, s } of savings) {
    if (s <= 0) break;
    const ri = routeOf.get(i)!;
    const rj = routeOf.get(j)!;
    if (ri === rj) continue;
    let merged: number[] | null = null;
    // Join only at route ends, flipping routes as needed.
    if (ri[ri.length - 1] === i && rj[0] === j) merged = [...ri, ...rj];
    else if (rj[rj.length - 1] === j && ri[0] === i) merged = [...rj, ...ri];
    else if (ri[0] === i && rj[0] === j) merged = [...ri].reverse().concat(rj);
    else if (ri[ri.length - 1] === i && rj[rj.length - 1] === j) merged = ri.concat([...rj].reverse());
    if (!merged || loadOf(p, hub, merged) > p.shift + EPS) continue;
    for (const n of merged) routeOf.set(n, merged);
  }
  return [...new Set(routeOf.values())];
}

/** 2-opt within one route: reverse segments while that shortens the drive. */
function twoOpt(p: Problem, r: WorkRoute): boolean {
  let improvedAny = false;
  let improved = true;
  while (improved) {
    improved = false;
    const s = [r.hub, ...r.seq, r.hub];
    for (let i = 1; i < s.length - 2; i++) {
      for (let k = i + 1; k < s.length - 1; k++) {
        const delta = t(p, s[i - 1], s[k]) + t(p, s[i], s[k + 1]) - t(p, s[i - 1], s[i]) - t(p, s[k], s[k + 1]);
        if (delta < -EPS) {
          const reversed = s.slice(i, k + 1).reverse();
          s.splice(i, k - i + 1, ...reversed);
          improved = improvedAny = true;
        }
      }
    }
    r.seq = s.slice(1, -1);
  }
  return improvedAny;
}

/** Move one job to its best position in any route if that lowers total drive time. */
function relocatePass(p: Problem, routes: WorkRoute[]): boolean {
  let improved = false;
  for (const from of routes) {
    for (let i = 0; i < from.seq.length; i++) {
      const node = from.seq[i];
      const prev = i === 0 ? from.hub : from.seq[i - 1];
      const next = i === from.seq.length - 1 ? from.hub : from.seq[i + 1];
      const removalGain = t(p, prev, node) + t(p, node, next) - t(p, prev, next);
      let best: { to: WorkRoute; pos: number; gain: number } | null = null;
      for (const to of routes) {
        const seq = to === from ? from.seq.filter((_, k) => k !== i) : to.seq;
        const probe: WorkRoute = { ...to, seq };
        const load = loadOf(p, to.hub, seq);
        for (let pos = 0; pos <= seq.length; pos++) {
          const delta = insertionDelta(p, probe, node, pos);
          const fits = to === from || load + delta <= p.shift + EPS;
          const gain = removalGain - (delta - p.service[node]);
          if (fits && gain > EPS && (!best || gain > best.gain)) best = { to, pos, gain };
        }
      }
      if (best) {
        from.seq.splice(i, 1);
        best.to.seq.splice(best.pos, 0, node);
        improved = true;
        i--;
      }
    }
  }
  return improved;
}

/** Exchange two jobs between routes if both stay within shift and total drive drops. */
function swapPass(p: Problem, routes: WorkRoute[]): boolean {
  let improved = false;
  for (let a = 0; a < routes.length; a++) {
    for (let b = a + 1; b < routes.length; b++) {
      const ra = routes[a];
      const rb = routes[b];
      for (let i = 0; i < ra.seq.length; i++) {
        for (let k = 0; k < rb.seq.length; k++) {
          const sa = [...ra.seq];
          const sb = [...rb.seq];
          [sa[i], sb[k]] = [sb[k], sa[i]];
          const before = driveOf(p, ra.hub, ra.seq) + driveOf(p, rb.hub, rb.seq);
          const after = driveOf(p, ra.hub, sa) + driveOf(p, rb.hub, sb);
          if (after < before - EPS && loadOf(p, ra.hub, sa) <= p.shift + EPS && loadOf(p, rb.hub, sb) <= p.shift + EPS) {
            ra.seq = sa;
            rb.seq = sb;
            improved = true;
          }
        }
      }
    }
  }
  return improved;
}

/** Insert unserved jobs, highest priority first, at the cheapest feasible spot. */
function insertUnassigned(p: Problem, routes: WorkRoute[], unassigned: number[]): number[] {
  const remaining = [...unassigned].sort((a, b) => p.weight[b] - p.weight[a] || p.service[a] - p.service[b]);
  const left: number[] = [];
  for (const node of remaining) {
    let best: { r: WorkRoute; pos: number; delta: number } | null = null;
    for (const r of routes) {
      const ins = bestInsertion(p, r, node, loadOf(p, r.hub, r.seq));
      if (ins && (!best || ins.delta < best.delta)) best = { r, ...ins };
    }
    if (best) best.r.seq.splice(best.pos, 0, node);
    else left.push(node);
  }
  return left;
}

/**
 * Make room for an unserved job by dropping a lower-priority one from a route, when the
 * higher-priority job then fits. Keeps urgent calls from being left behind by routine work.
 */
function priorityExchange(p: Problem, routes: WorkRoute[], unassigned: number[]): number[] {
  const left = [...unassigned].sort((a, b) => p.weight[b] - p.weight[a]);
  for (let u = 0; u < left.length; u++) {
    const node = left[u];
    let best: { r: WorkRoute; drop: number; pos: number; cost: number } | null = null;
    for (const r of routes) {
      for (let i = 0; i < r.seq.length; i++) {
        const victim = r.seq[i];
        if (p.weight[victim] >= p.weight[node]) continue;
        const without: WorkRoute = { ...r, seq: r.seq.filter((_, k) => k !== i) };
        const ins = bestInsertion(p, without, node, loadOf(p, r.hub, without.seq));
        if (ins) {
          const cost = p.weight[victim] * 1000 + ins.delta;
          if (!best || cost < best.cost) best = { r, drop: i, pos: ins.pos, cost };
        }
      }
    }
    if (best) {
      const [victim] = best.r.seq.splice(best.drop, 1);
      best.r.seq.splice(best.pos, 0, node);
      left.splice(u, 1, victim);
      u = -1; // the victim may fit elsewhere; rescan from the top
      left.sort((a, b) => p.weight[b] - p.weight[a]);
    }
  }
  return left;
}

function localSearch(p: Problem, routes: WorkRoute[], maxPasses = 40): void {
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (const r of routes) improved = twoOpt(p, r) || improved;
    improved = relocatePass(p, routes) || improved;
    improved = swapPass(p, routes) || improved;
    if (!improved) break;
  }
}

function optimizedRoutes(p: Problem): { routes: WorkRoute[]; unassigned: number[] } {
  const { hubs, technicians, jobs } = p.input;
  const routes: WorkRoute[] = technicians.map((tech) => ({ tech, hub: hubs.findIndex((h) => h.id === tech.hubId), seq: [] }));
  const staffedHubs = [...new Set(routes.map((r) => r.hub))];
  if (staffedHubs.length === 0) return { routes, unassigned: jobs.map((_, k) => p.hubCount + k) };

  // 1. Cluster: each job goes to its nearest staffed hub.
  const byHub = new Map<number, number[]>(staffedHubs.map((h) => [h, []]));
  jobs.forEach((_, k) => {
    const node = p.hubCount + k;
    const hub = staffedHubs.reduce((best, h) => (t(p, h, node) < t(p, best, node) ? h : best));
    byHub.get(hub)!.push(node);
  });

  // 2. Construct: savings routes per hub; the crew takes the most valuable ones.
  let unassigned: number[] = [];
  for (const [hub, nodes] of byHub) {
    const crew = routes.filter((r) => r.hub === hub);
    const value = (seq: number[]) => seq.reduce((s, n) => s + p.weight[n], 0);
    const candidates = savingsRoutes(p, hub, nodes).sort((a, b) => value(b) - value(a));
    crew.forEach((r, i) => (r.seq = candidates[i] ?? []));
    for (const extra of candidates.slice(crew.length)) unassigned.push(...extra);
  }

  // 3. Improve: fill gaps with leftover jobs, tighten routes, and repeat once routes have shrunk.
  for (let round = 0; round < 3; round++) {
    unassigned = insertUnassigned(p, routes, unassigned);
    unassigned = priorityExchange(p, routes, unassigned);
    localSearch(p, routes);
  }
  unassigned = insertUnassigned(p, routes, unassigned);
  for (const r of routes) twoOpt(p, r);
  return { routes, unassigned };
}

// ---------------------------------------------------------------------------------------------
// Scheduling and metrics
// ---------------------------------------------------------------------------------------------

function toRoute(p: Problem, r: WorkRoute): Route {
  const { jobs, settings } = p.input;
  let clock = settings.dayStartMin;
  let prev = r.hub;
  let distanceKm = 0;
  const stops: Stop[] = [];
  for (const node of r.seq) {
    clock += t(p, prev, node);
    distanceKm += p.dist[prev * p.nodeCount + node];
    const job = jobs[node - p.hubCount];
    stops.push({ jobId: job.id, arriveMin: clock, departMin: clock + job.serviceMin });
    clock += job.serviceMin;
    prev = node;
  }
  if (r.seq.length) {
    clock += t(p, prev, r.hub);
    distanceKm += p.dist[prev * p.nodeCount + r.hub];
  }
  const serviceMin = r.seq.reduce((s, n) => s + p.service[n], 0);
  return {
    technicianId: r.tech.id,
    hubId: p.input.hubs[r.hub].id,
    jobIds: stops.map((s) => s.jobId),
    stops,
    driveMin: driveOf(p, r.hub, r.seq),
    serviceMin,
    distanceKm,
    endMin: r.seq.length ? clock : settings.dayStartMin,
  };
}

export function computeMetrics(routes: Route[], jobs: Job[], shiftMin: number): PlanMetrics {
  const served = new Set(routes.flatMap((r) => r.jobIds));
  const urgent = jobs.filter((j) => j.priority === 1);
  const driveMin = routes.reduce((s, r) => s + r.driveMin, 0);
  const busy = routes.reduce((s, r) => s + r.driveMin + r.serviceMin, 0);
  return {
    jobsServed: served.size,
    jobsTotal: jobs.length,
    urgentServed: urgent.filter((j) => served.has(j.id)).length,
    urgentTotal: urgent.length,
    driveMin,
    distanceKm: routes.reduce((s, r) => s + r.distanceKm, 0),
    utilization: routes.length ? busy / (routes.length * shiftMin) : 0,
    driveMinPerJob: served.size ? driveMin / served.size : 0,
  };
}

export function planRoutes(input: PlanInput, strategy: Plan['strategy']): Plan {
  const p = buildProblem(input);
  const { routes, unassigned } = strategy === 'baseline' ? baselineRoutes(p) : optimizedRoutes(p);
  const scheduled = routes.map((r) => toRoute(p, r));
  return {
    strategy,
    routes: scheduled,
    unassignedJobIds: unassigned.map((n) => input.jobs[n - p.hubCount].id),
    metrics: computeMetrics(scheduled, input.jobs, input.settings.shiftMin),
  };
}
