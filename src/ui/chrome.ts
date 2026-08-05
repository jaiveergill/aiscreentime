import { h, svg } from './dom.ts';

/**
 * Shell chrome: sidebar, topbar, icons.
 *
 * Icons are inline SVG rather than a font or sprite sheet — the dashboard ships
 * with `default-src 'none'` and must stay entirely self-contained.
 */

function icon(paths: string[], size = 15): SVGElement {
  return svg(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.8',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    ...paths.map((d) => svg('path', { d })),
  );
}

export const ICONS = {
  overview: () => icon(['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z']),
  timeline: () => icon(['M3 6h13', 'M3 12h18', 'M3 18h9', 'M19 4v4', 'M8 16v4']),
  projects: () =>
    icon(['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']),
  tasks: () =>
    icon(['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11']),
  sessions: () => icon(['M4 17l6-6-6-6', 'M12 19h8']),
  method: () => icon(['M9 3v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3', 'M8 3h8', 'M6 14h12']),
  data: () =>
    icon([
      'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z',
      'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
      'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    ]),
  settings: () =>
    icon([
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    ]),
  privacy: () => icon(['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z']),
  share: () => icon(['M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7', 'M16 6l-4-4-4 4', 'M12 2v14']),
  chevL: () => icon(['M15 18l-6-6 6-6'], 14),
  chevR: () => icon(['M9 18l6-6-6-6'], 14),
  arrowR: () => icon(['M5 12h14', 'M13 6l6 6-6 6'], 13),
  sun: () =>
    icon([
      'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
      'M12 1v2',
      'M12 21v2',
      'M4.2 4.2l1.4 1.4',
      'M18.4 18.4l1.4 1.4',
      'M1 12h2',
      'M21 12h2',
      'M4.2 19.8l1.4-1.4',
      'M18.4 5.6l1.4-1.4',
    ]),
  refresh: () =>
    icon([
      'M21 2v6h-6',
      'M3 12a9 9 0 0 1 15-6.7L21 8',
      'M3 22v-6h6',
      'M21 12a9 9 0 0 1-15 6.7L3 16',
    ]),
  pulse: () => icon(['M3 12h4l3 8 4-16 3 8h4']),
};

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly hash: string;
  readonly icon: () => SVGElement;
  readonly section?: string;
}

export const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', hash: '/day', icon: ICONS.overview },
  { key: 'timeline', label: 'Timeline', hash: '/timeline', icon: ICONS.timeline },
  { key: 'projects', label: 'Projects', hash: '/projects', icon: ICONS.projects },
  { key: 'tasks', label: 'Tasks', hash: '/tasks', icon: ICONS.tasks },
  { key: 'share', label: 'Share', hash: '/share', icon: ICONS.share },
  { key: 'method', label: 'Method', hash: '/methodology', icon: ICONS.method, section: 'Data' },
  { key: 'diagnostics', label: 'Collector', hash: '/diagnostics', icon: ICONS.data },
  {
    key: 'settings',
    label: 'Preferences',
    hash: '/settings',
    icon: ICONS.settings,
    section: 'Settings',
  },
  { key: 'privacy', label: 'Privacy', hash: '/privacy', icon: ICONS.privacy },
];

export function sidebar(active: string, go: (hash: string) => void): HTMLElement {
  const items: (Node | null)[] = [];
  for (const n of NAV) {
    if (n.section) items.push(h('div', { class: 'side-section' }, n.section));
    items.push(
      h(
        'button',
        {
          class: 'side-item',
          'aria-current': active === n.key ? 'page' : null,
          onclick: () => go(n.hash),
        },
        n.icon(),
        n.label,
      ),
    );
  }

  return h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'side-brand' }, ICONS.pulse(), 'Leverage'),
    h('nav', { class: 'side-nav', 'aria-label': 'Sections' }, ...items),
    h(
      'div',
      { class: 'side-foot' },
      h(
        'div',
        { class: 'side-privacy' },
        h('b', {}, 'All data is local'),
        h('span', {}, 'Nothing leaves this machine.'),
      ),
    ),
  );
}
