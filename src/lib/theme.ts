/**
 * Route colors: an 8-slot categorical palette, validated for color-vision deficiency on adjacent
 * pairs, with separate steps for light and dark surfaces. Each technician owns one slot.
 */
type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export interface MapTheme {
  mode: 'light' | 'dark';
  routeHex: string[];
  route: RGB[];
  surface: RGB;
  ink: RGB;
  muted: RGB;
  unassigned: RGB;
  land: string;
  outside: string;
  water: string;
  urban: string;
  road: string;
  roadMajor: string;
  boundary: string;
  county: string;
}

export const THEMES: Record<'light' | 'dark', MapTheme> = {
  light: {
    mode: 'light',
    routeHex: LIGHT,
    route: LIGHT.map(hex),
    surface: hex('#fcfcfb'),
    ink: hex('#0b0b0b'),
    muted: hex('#52514e'),
    unassigned: hex('#8a8984'),
    land: '#f4f3ef',
    outside: '#e9e8e3',
    water: '#c9dcef',
    urban: '#e6e2d8',
    road: '#d9d6cc',
    roadMajor: '#c9c5b8',
    boundary: '#a8a69e',
    county: '#dcdad3',
  },
  dark: {
    mode: 'dark',
    routeHex: DARK,
    route: DARK.map(hex),
    surface: hex('#1a1a19'),
    ink: hex('#f0efec'),
    muted: hex('#c3c2b7'),
    unassigned: hex('#8f8e88'),
    land: '#222221',
    outside: '#1a1a19',
    water: '#20354a',
    urban: '#2c2b29',
    road: '#3a3936',
    roadMajor: '#4a4945',
    boundary: '#6b6a64',
    county: '#2f2e2c',
  },
};
