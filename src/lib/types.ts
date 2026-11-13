export type LngLat = [lon: number, lat: number];

export type Priority = 1 | 2 | 3;

export interface Town {
  id: number;
  name: string;
  population: number;
  lon: number;
  lat: number;
}

export interface Hub {
  id: string;
  name: string;
  position: LngLat;
}

export interface Technician {
  id: string;
  name: string;
  hubId: string;
  /** Index into the categorical route palette. Fixed per technician so colors never repaint. */
  colorSlot: number;
}

export interface Job {
  id: string;
  /** Order the request came in; the baseline dispatcher works in this order. */
  receivedOrder: number;
  position: LngLat;
  town: string;
  customer: string;
  workType: string;
  serviceMin: number;
  priority: Priority;
}

export interface PlannerSettings {
  /** Length of a technician's shift, in minutes. */
  shiftMin: number;
  /** Average driving speed, km/h. */
  speedKmh: number;
  /** Ratio of road distance to straight-line distance. */
  circuity: number;
  /** Shift start, minutes after midnight. */
  dayStartMin: number;
}

export interface Stop {
  jobId: string;
  arriveMin: number;
  departMin: number;
}

export interface Route {
  technicianId: string;
  hubId: string;
  jobIds: string[];
  stops: Stop[];
  driveMin: number;
  serviceMin: number;
  distanceKm: number;
  /** Clock time the technician is back at the hub. */
  endMin: number;
}

export interface Plan {
  strategy: 'baseline' | 'optimized';
  routes: Route[];
  unassignedJobIds: string[];
  metrics: PlanMetrics;
}

export interface PlanMetrics {
  jobsServed: number;
  jobsTotal: number;
  urgentServed: number;
  urgentTotal: number;
  driveMin: number;
  distanceKm: number;
  /** Average share of the shift spent driving or on site, across technicians on shift. */
  utilization: number;
  /** Driving minutes per job served. */
  driveMinPerJob: number;
}
