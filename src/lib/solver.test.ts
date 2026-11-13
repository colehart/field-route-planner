import { describe, expect, it } from 'vitest';
import { haversineKm } from './geo';
import { DEFAULT_SETTINGS, HUBS, TECHNICIANS, generateJobs } from './scenario';
import { planRoutes, type PlanInput } from './solver';
import type { Job } from './types';

const input = (jobs: Job[], overrides: Partial<PlanInput> = {}): PlanInput => ({
  hubs: HUBS,
  technicians: TECHNICIANS,
  jobs,
  settings: DEFAULT_SETTINGS,
  ...overrides,
});

describe('haversineKm', () => {
  it('matches the known Denver to Fort Collins distance', () => {
    const km = haversineKm(HUBS[0].position, HUBS[1].position);
    expect(km).toBeGreaterThan(93);
    expect(km).toBeLessThan(97);
  });
});

describe('generateJobs', () => {
  it('is reproducible for a seed', () => {
    expect(generateJobs(20, 7)).toEqual(generateJobs(20, 7));
    expect(generateJobs(20, 7)).not.toEqual(generateJobs(20, 8));
  });
});

describe.each([1, 2, 3, 42])('planRoutes with seed %i', (seed) => {
  const jobs = generateJobs(70, seed);
  const baseline = planRoutes(input(jobs), 'baseline');
  const optimized = planRoutes(input(jobs), 'optimized');

  it.each([baseline, optimized])('keeps every $strategy route inside the shift', (plan) => {
    for (const route of plan.routes) {
      expect(route.endMin - DEFAULT_SETTINGS.dayStartMin).toBeLessThanOrEqual(DEFAULT_SETTINGS.shiftMin + 1e-6);
      expect(route.driveMin + route.serviceMin).toBeCloseTo(route.endMin - DEFAULT_SETTINGS.dayStartMin, 6);
    }
  });

  it.each([baseline, optimized])('assigns each $strategy job exactly once or reports it unassigned', (plan) => {
    const seen = [...plan.routes.flatMap((r) => r.jobIds), ...plan.unassignedJobIds].sort();
    expect(seen).toEqual(jobs.map((j) => j.id).sort());
  });

  it('serves at least as many urgent jobs as the baseline', () => {
    expect(optimized.metrics.urgentServed).toBeGreaterThanOrEqual(baseline.metrics.urgentServed);
  });

  it('beats the baseline on drive time per job', () => {
    expect(optimized.metrics.driveMinPerJob).toBeLessThan(baseline.metrics.driveMinPerJob);
  });
});

describe('planRoutes edge cases', () => {
  it('serves everything when the crew has room', () => {
    const plan = planRoutes(input(generateJobs(12, 5)), 'optimized');
    expect(plan.unassignedJobIds).toEqual([]);
  });

  it('leaves all jobs unassigned with nobody on shift', () => {
    const jobs = generateJobs(5, 5);
    const plan = planRoutes(input(jobs, { technicians: [] }), 'optimized');
    expect(plan.unassignedJobIds).toHaveLength(5);
    expect(plan.routes).toHaveLength(0);
  });

  it('starts and ends routes at the technician hub', () => {
    const plan = planRoutes(input(generateJobs(30, 9)), 'optimized');
    for (const route of plan.routes) {
      const tech = TECHNICIANS.find((t) => t.id === route.technicianId)!;
      expect(route.hubId).toBe(tech.hubId);
    }
  });
});
