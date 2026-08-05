import { api, h, mount } from './dom.ts';
import type { AppState } from './app.ts';

/**
 * Share card export.
 *
 * The card is rendered locally as SVG by the server and rasterised here with
 * canvas. Nothing is uploaded, no remote link is minted, and no rendering
 * service is contacted — the PNG is produced in the page and handed straight
 * to a download.
 *
 * The page is deliberately almost wordless. The preview is the explanation:
 * whatever the card will contain is already visible in it, so prose here would
 * only restate the picture. The one thing the picture cannot show is what it
 * *omits*, which is why the exposure list survives — folded away, and generated
 * from the same options the renderer receives so it cannot drift.
 */

interface Options {
  variant: 'headline' | 'timeline' | 'projects' | 'weekly';
  theme: 'dark' | 'light';
  revealProjects: boolean;
}

export function renderShare(state: AppState): HTMLElement {
  const opts: Options = { variant: 'headline', theme: 'dark', revealProjects: false };
  const preview = h(
    'div',
    { class: 'share-preview' },
    h('div', { class: 'skeleton', style: { height: '340px' } }),
  );
  const exposure = h('ul', { class: 'exposure' });
  const status = h('div', { style: { minHeight: '20px', fontSize: '12px' } });

  let currentSvg = '';

  const query = (): string =>
    `variant=${opts.variant}&theme=${opts.theme}&revealProjects=${opts.revealProjects ? '1' : '0'}`;

  const refreshPreview = async (): Promise<void> => {
    try {
      const [svgText, exp] = await Promise.all([
        fetch(`/api/share/${state.day}?${query()}`).then((r) => r.text()),
        api<{ exposure: string[] }>(`/api/share-preview/${state.day}?${query()}`),
      ]);
      currentSvg = svgText;
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
      img.alt = 'Share card preview';
      img.style.width = '100%';
      img.style.display = 'block';
      mount(preview, img);
      mount(exposure, ...exp.exposure.map((line) => h('li', {}, line)));
    } catch (err) {
      mount(preview, h('div', { class: 'banner warn' }, String(err)));
    }
  };

  void refreshPreview();

  const variantBtn = (value: Options['variant'], label: string): HTMLElement =>
    h(
      'button',
      {
        class: `btn${value === opts.variant ? ' btn-primary' : ''}`,
        'data-variant': value,
        onclick: (e: Event) => {
          opts.variant = value;
          for (const b of document.querySelectorAll<HTMLElement>('[data-variant]')) {
            b.classList.toggle('btn-primary', b === e.currentTarget);
          }
          void refreshPreview();
        },
      },
      label,
    );

  const download = async (scale: number): Promise<void> => {
    if (!currentSvg) return;
    mount(status, h('span', { class: 'faint' }, 'Rendering…'));
    try {
      const blobUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(currentSvg)}`;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not rasterise the card.'));
        img.src = blobUrl;
      });
      const w = 1200 * scale;
      const hpx = 675 * scale;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hpx;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is unavailable in this browser.');
      ctx.drawImage(img, 0, 0, w, hpx);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('Could not encode the image.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(png);
      a.download = `leverage-${state.day}-${opts.variant}@${scale}x.png`;
      a.click();
      URL.revokeObjectURL(a.href);
      mount(status, h('span', { style: { color: 'var(--verified)' } }, `Saved ${w}×${hpx}.`));
    } catch (err) {
      mount(status, h('span', { style: { color: 'var(--fail)' } }, String(err)));
    }
  };

  const saveSvg = (): void => {
    if (!currentSvg) return;
    const blob = new Blob([currentSvg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leverage-${state.day}-${opts.variant}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return h(
    'main',
    { id: 'main', class: 'page' },
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'band-head' },
        h('h2', {}, 'Share'),
        h('span', { class: 'note' }, 'Rendered and saved on this machine'),
      ),
      h(
        'div',
        { class: 'grid-2' },
        h('div', {}, preview),
        h(
          'div',
          { class: 'stack', style: { gap: '14px' } },
          h(
            'div',
            { class: 'row' },
            variantBtn('headline', 'Headline'),
            variantBtn('timeline', 'Timeline'),
            variantBtn('projects', 'Projects'),
            variantBtn('weekly', 'Weekly'),
          ),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn btn-primary', onclick: () => void download(2) }, 'PNG 2×'),
            h('button', { class: 'btn', onclick: () => void download(3) }, 'PNG 3×'),
            h('button', { class: 'btn', onclick: saveSvg }, 'SVG'),
            h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  opts.theme = opts.theme === 'dark' ? 'light' : 'dark';
                  void refreshPreview();
                },
              },
              'Theme',
            ),
          ),
          status,
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              onchange: (e: Event) => {
                opts.revealProjects = (e.target as HTMLInputElement).checked;
                void refreshPreview();
              },
            }),
            h('span', {}, 'Real project names'),
          ),
          h('details', { class: 'panel' }, h('summary', {}, 'What this exports'), exposure),
        ),
      ),
    ),
  );
}
