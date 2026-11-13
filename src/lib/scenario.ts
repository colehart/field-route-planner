import townsData from '../data/towns.json';
import { createRng, offsetKm } from './geo';
import type { Hub, Job, LngLat, PlannerSettings, Priority, Technician, Town } from './types';

export const TOWNS = townsData as Town[];

/** Service hubs, placed at real town centers (GeoNames). */
export const HUBS: Hub[] = [
  { id: 'den', name: 'Denver', position: [-104.9847, 39.7392] },
  { id: 'foco', name: 'Fort Collins', position: [-105.0844, 40.5853] },
  { id: 'cos', name: 'Colorado Springs', position: [-104.8214, 38.8339] },
  { id: 'ftm', name: 'Fort Morgan', position: [-103.7999, 40.2503] },
];

/** The crew. Eight technicians, each with a fixed color slot (color follows the person, not the rank). */
export const TECHNICIANS: Technician[] = [
  { id: 't1', name: 'Maya Ortiz', hubId: 'den', colorSlot: 0 },
  { id: 't2', name: 'Jordan Lee', hubId: 'foco', colorSlot: 1 },
  { id: 't3', name: 'Sam Patel', hubId: 'cos', colorSlot: 2 },
  { id: 't4', name: 'Riley Chen', hubId: 'ftm', colorSlot: 3 },
  { id: 't5', name: 'Alex Romero', hubId: 'den', colorSlot: 4 },
  { id: 't6', name: 'Taylor Brooks', hubId: 'foco', colorSlot: 5 },
  { id: 't7', name: 'Casey Nguyen', hubId: 'cos', colorSlot: 6 },
  { id: 't8', name: 'Morgan Diaz', hubId: 'den', colorSlot: 7 },
];

export const DEFAULT_SETTINGS: PlannerSettings = {
  shiftMin: 9 * 60,
  speedKmh: 72,
  circuity: 1.3,
  dayStartMin: 7 * 60 + 30,
};

interface WorkTemplate {
  workType: string;
  customers: string[];
  minutes: [min: number, max: number];
  /** Larger values favor bigger towns, negative values favor small, rural towns. */
  urbanBias: number;
  /** How far from the town center the site can be, km. */
  spreadKm: number;
}

const WORK: WorkTemplate[] = [
  { workType: 'Refrigeration repair', customers: ['Grocery', 'Cold storage', 'Restaurant supply'], minutes: [45, 120], urbanBias: 1, spreadKm: 4 },
  { workType: 'HVAC preventive maintenance', customers: ['Clinic', 'School district', 'Office park'], minutes: [30, 75], urbanBias: 1, spreadKm: 5 },
  { workType: 'Irrigation pivot service', customers: ['Family farm', 'Ag co-op', 'Sod farm'], minutes: [40, 90], urbanBias: -1, spreadKm: 14 },
  { workType: 'Grain dryer inspection', customers: ['Grain elevator', 'Ag co-op'], minutes: [45, 100], urbanBias: -1, spreadKm: 8 },
  { workType: 'Generator load test', customers: ['Water district', 'Hospital', 'Cell site'], minutes: [30, 60], urbanBias: 0, spreadKm: 8 },
  { workType: 'Ice machine install', customers: ['Convenience store', 'Hotel', 'Restaurant'], minutes: [60, 120], urbanBias: 0.5, spreadKm: 4 },
];

const PRIORITY_ODDS: [Priority, number][] = [
  [1, 0.15],
  [2, 0.35],
  [3, 0.5],
];

function pickWeighted<T>(items: T[], weights: number[], rand: () => number): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pickPriority(rand: () => number): Priority {
  return pickWeighted(
    PRIORITY_ODDS.map(([p]) => p),
    PRIORITY_ODDS.map(([, w]) => w),
    rand,
  );
}

/**
 * Generate a day of service requests. Locations are real towns from GeoNames; the jobs on top of
 * them (customer, work type, duration, priority) are synthetic and reproducible from the seed.
 */
export function generateJobs(count: number, seed: number): Job[] {
  const rand = createRng(seed);
  const jobs: Job[] = [];
  for (let i = 0; i < count; i++) {
    const template = WORK[Math.floor(rand() * WORK.length)];
    const weights = TOWNS.map((t) => Math.pow(t.population, 0.35 * template.urbanBias + 0.15));
    const town = pickWeighted(TOWNS, weights, rand);
    const base: LngLat = [town.lon, town.lat];
    const position = offsetKm(base, Math.sqrt(rand()) * template.spreadKm, rand() * Math.PI * 2);
    const [lo, hi] = template.minutes;
    jobs.push({
      id: `J-${String(1001 + i)}`,
      receivedOrder: i,
      position,
      town: town.name,
      customer: template.customers[Math.floor(rand() * template.customers.length)],
      workType: template.workType,
      serviceMin: Math.round((lo + rand() * (hi - lo)) / 5) * 5,
      priority: pickPriority(rand),
    });
  }
  return jobs;
}

/** An urgent call dropped onto the map by the user. */
export function createUrgentJob(position: LngLat, index: number, nearestTown: string): Job {
  return {
    id: `U-${String(index + 1).padStart(3, '0')}`,
    receivedOrder: 10_000 + index,
    position,
    town: nearestTown,
    customer: 'Emergency call',
    workType: 'Equipment down',
    serviceMin: 60,
    priority: 1,
  };
}
