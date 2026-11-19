/** The four colour themes (THEMES-4). `festival` is first and is the default everywhere:
 * the picker order, the `data-look`/`data-manga-theme` attributes, `/api/settings` `mangaTheme`
 * and the recap `look`. Legacy ids `ink`, `noir` and `pop` (and any missing or unknown stored
 * value) resolve to `festival` via resolveMangaTheme. Palette values come from report-themes4.md. */
export type MangaThemeId = 'festival' | 'sunset' | 'lagoon' | 'blossom';
/** `ink` is accepted as legacy input only; it is never a current theme and resolveMangaTheme
 * always turns it into a MangaThemeId. */
export type MangaTheme = MangaThemeId | 'ink';

interface ThreeStop { readonly start: string; readonly mid: string; readonly end: string }
export interface MangaThemePalette {
  readonly paper: string;
  readonly ink: string;
  /** Wash over grey art, 145 degrees, start to end. */
  readonly wash: ThreeStop;
  /** Paper tint under colour art, 145 degrees, start to end. Every theme has one (THEMES-4 r2). */
  readonly tint: ThreeStop;
  /** Grade of colour art: blend mode and opacity of the layer, which paints `grade.wash` when set, else `wash`. */
  readonly grade: { readonly blend: 'soft-light'; readonly opacity: number; readonly wash?: ThreeStop };
  readonly balloon: { readonly fill: string; readonly text: string };
  /** SFX fill. Kept apart from every wash stop (CRIT-NICE N3: it used to equal wash.mid, so the fill vanished over
   * the middle of a grey-art wash) and at least 4.5:1 on its stroke. */
  readonly sfx: string;
  /** SFX stroke and hard shadow, live (.ct-sfx), in the recap (.story-sfx) and in the PNG. Unset means ink: --ink
   * (#0b0b0c) live and in the PNG, `ink` in the recap. CRIT-NICE r2 N3: Sunset and Lagoon wash out to a light end
   * stop, so no fill can be 1.5:1 on every stop and 4.5:1 on ink at once; they letter a deep fill over this light
   * stroke instead, as Festival's classic recap SFX already does. */
  readonly sfxStroke?: string;
  readonly accent: readonly [string, string, string];
}
export interface MangaThemeDefinition {
  readonly id: MangaThemeId;
  readonly name: string;
  readonly short: string;
  readonly blurb: string;
  readonly palette: MangaThemePalette;
}

/** How colour art is graded by its theme's own wash (critique M2): one 145-degree wash layer over the
 * image, blended soft-light at 35%. The same for every theme; read as `palette.grade` by lookStyles here and
 * by the PNG export (apps/web/src/ui/export.ts). */
const COLOUR_GRADE = { blend: 'soft-light', opacity: 0.35 } as const;

export const DEFAULT_MANGA_THEME: MangaThemeId = 'festival';
export const MANGA_THEME_IDS: readonly MangaThemeId[] = ['festival', 'sunset', 'lagoon', 'blossom'];

export const mangaThemes: readonly MangaThemeDefinition[] = [
  {
    id: 'festival', name: 'Festival colour', short: 'Festival',
    blurb: 'Teal, amber and coral washes light every panel, colour or grey.',
    palette: {
      paper: '#fff5e8', ink: '#142b36',
      wash: { start: '#4cc3cf', mid: '#ffd27a', end: '#ff8a8a' },
      tint: { start: '#ddf4f6', mid: '#fff0d4', end: '#ffe1e1' },
      grade: { ...COLOUR_GRADE, wash: { start: '#1da2b3', mid: '#0f6a78', end: '#0b4f5c' } },
      balloon: { fill: '#fffdf5', text: '#142b36' },
      sfx: '#d6faff', accent: ['#1da2b3', '#ffc258', '#ee6471'],
    },
  },
  {
    id: 'sunset', name: 'Sunset glow', short: 'Sunset',
    blurb: 'Magenta, orange and gold washes, with a warm pink tint over colour art.',
    palette: {
      paper: '#fff1ea', ink: '#3a1029',
      wash: { start: '#f0679a', mid: '#ffa462', end: '#ffd97a' },
      tint: { start: '#ffe3ec', mid: '#ffeedd', end: '#fff6d9' },
      grade: COLOUR_GRADE,
      balloon: { fill: '#fff8f2', text: '#3a1029' },
      sfx: '#9b1d5c', sfxStroke: '#fff8f2', accent: ['#e4407a', '#ff8a3d', '#ffd166'],
    },
  },
  {
    id: 'lagoon', name: 'Lagoon', short: 'Lagoon',
    blurb: 'Cobalt, cyan and lime washes, with a cool aqua tint over colour art.',
    palette: {
      paper: '#eef9f7', ink: '#0d2a3f',
      wash: { start: '#5b8ff0', mid: '#5fd6e3', end: '#bdeb86' },
      tint: { start: '#e3edff', mid: '#ddf7fa', end: '#eefbdd' },
      grade: COLOUR_GRADE,
      balloon: { fill: '#f7fffd', text: '#0d2a3f' },
      sfx: '#1d4a9e', sfxStroke: '#f7fffd', accent: ['#2f6fdf', '#2ec4d6', '#a8e063'],
    },
  },
  {
    id: 'blossom', name: 'Blossom', short: 'Blossom',
    blurb: 'Violet, pink and mint washes, with a soft lilac tint over colour art.',
    palette: {
      paper: '#fbf1fb', ink: '#2e1446',
      wash: { start: '#a884f8', mid: '#ff9bd3', end: '#9debd3' },
      tint: { start: '#efe7ff', mid: '#ffe6f4', end: '#e2f8f1' },
      grade: COLOUR_GRADE,
      balloon: { fill: '#fffaff', text: '#2e1446' },
      sfx: '#f7f2ff', accent: ['#8e5cf6', '#ff7ac6', '#7fe3c4'],
    },
  },
];

/** A valid id stays; anything else ('ink', 'noir', 'pop', undefined, junk) becomes the default. */
export const resolveMangaTheme = (value: unknown): MangaThemeId =>
  mangaThemes.some((theme) => theme.id === value) ? (value as MangaThemeId) : DEFAULT_MANGA_THEME;

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Festival keeps the exact classic rules it already shipped with.
const FESTIVAL_CLASSIC = `
.manga-pages[data-manga-theme=festival] .manga-page{background:#fff5e8;color:#142b36}
.manga-pages[data-manga-theme=festival] .manga-heading,.manga-pages[data-manga-theme=festival] .manga-footer{color:#244451}
.manga-pages[data-manga-theme=festival] .manga-sample{color:#142b36}
.manga-pages[data-manga-theme=festival] .panel-art>img{filter:sepia(.7) saturate(1.8) contrast(1.08)}
.manga-pages[data-manga-theme=festival] .panel-art::after{content:'';position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(145deg,rgba(29,162,179,.6),rgba(255,194,88,.28) 48%,rgba(238,100,113,.54));mix-blend-mode:multiply}
.manga-pages[data-manga-theme=festival] .story-panel{border-color:#142b36}
.manga-pages[data-manga-theme=festival] .story-balloon{background:#fffdf5;color:#142b36;border-color:#142b36}
.manga-pages[data-manga-theme=festival] .story-balloon::after{background:#fffdf5;border-color:#142b36}
.manga-pages[data-manga-theme=festival] .story-chat{background:#d9f1e6}
.manga-pages[data-manga-theme=festival] .story-sfx{color:#a52b48;-webkit-text-stroke-color:#fff5e8;text-shadow:1px 2px #fff5e8}
`;

// The other three themes follow the same shape as the festival rules above, built from their own palette.
function classicRules(theme: MangaThemeDefinition): string {
  const { id, palette } = theme;
  const [a1, a2, a3] = palette.accent;
  return `
.manga-pages[data-manga-theme=${id}] .manga-page{background:${palette.paper};color:${palette.ink}}
.manga-pages[data-manga-theme=${id}] .manga-heading,.manga-pages[data-manga-theme=${id}] .manga-footer{color:${palette.ink}}
.manga-pages[data-manga-theme=${id}] .manga-sample{color:${palette.ink}}
.manga-pages[data-manga-theme=${id}] .panel-art>img{filter:saturate(1.3) contrast(1.08)}
.manga-pages[data-manga-theme=${id}] .panel-art::after{content:'';position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(145deg,${hexToRgba(a1, .6)},${hexToRgba(a2, .28)} 48%,${hexToRgba(a3, .54)});mix-blend-mode:multiply}
.manga-pages[data-manga-theme=${id}] .story-panel{border-color:${palette.ink}}
.manga-pages[data-manga-theme=${id}] .story-balloon{background:${palette.balloon.fill};color:${palette.balloon.text};border-color:${palette.ink}}
.manga-pages[data-manga-theme=${id}] .story-balloon::after{background:${palette.balloon.fill};border-color:${palette.ink}}
.manga-pages[data-manga-theme=${id}] .story-chat{background:${palette.tint.start}}
.manga-pages[data-manga-theme=${id}] .story-sfx{color:${palette.sfx};-webkit-text-stroke-color:${palette.sfxStroke ?? palette.ink};text-shadow:1px 2px ${palette.sfxStroke ?? palette.ink}}
`;
}

/** Classic `.manga-pages[data-manga-theme=ID]` rules for all 4 themes. The `ink` attribute value is
 * never rendered: every caller resolves the theme first, so no rule targets it here. */
export const mangaThemeStyles = `
.manga-pages[data-manga-theme] .panel-art{isolation:isolate}
${FESTIVAL_CLASSIC}${mangaThemes.filter((theme) => theme.id !== DEFAULT_MANGA_THEME).map(classicRules).join('')}`;

// Legacy data-look values alias to the default theme's rules, so a stray unresolved attribute still renders sensibly.
const LEGACY_LOOK_VALUES = ['ink', 'noir', 'pop'];
function lookSelectors(template: (value: string) => string, id: MangaThemeId): string {
  const values = id === DEFAULT_MANGA_THEME ? [id, ...LEGACY_LOOK_VALUES] : [id];
  return values.map(template).join(',');
}

function lookRules(theme: MangaThemeDefinition): string {
  const { id, palette } = theme;
  const { wash, tint } = palette;
  const washGradient = `linear-gradient(145deg,${wash.start} 0%,${wash.mid} 50%,${wash.end} 100%)`;
  const tintGradient = `linear-gradient(145deg,${tint.start} 0%,${tint.mid} 50%,${tint.end} 100%)`;
  const colourFilter = 'saturate(1.25) contrast(1.06)';
  const { start, mid, end } = palette.grade.wash ?? wash;
  const grade = `content:'';position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(145deg,${start} 0%,${mid} 50%,${end} 100%);mix-blend-mode:${palette.grade.blend};opacity:${palette.grade.opacity}`;
  return `
${lookSelectors((value) => `.ct-art[data-look=${value}]`, id)}{background:${tintGradient}}
${lookSelectors((value) => `.ct-art[data-look=${value}]>img`, id)}{filter:${colourFilter}}
${lookSelectors((value) => `.ct-art[data-look=${value}]:not([data-tone=grey])::after`, id)}{${grade}}
${lookSelectors((value) => `.ct-art[data-look=${value}][data-tone=grey]`, id)}{background:${washGradient}}
${lookSelectors((value) => `.ct-art[data-look=${value}][data-tone=grey]>img`, id)}{filter:grayscale(1) contrast(1.15) brightness(1.06)}
${lookSelectors((value) => `.ct-panel[data-look=${value}] .ct-sfx`, id)}{color:${palette.sfx}${palette.sfxStroke ? `;-webkit-text-stroke-color:${palette.sfxStroke};text-shadow:3px 3px 0 ${palette.sfxStroke}` : ''}}
`;
}

/** `.ct-art[data-look=ID]` paper/wash and `>img` filter, the colour-art grade layer (`::after`), plus
 * `.ct-panel[data-look=ID] .ct-sfx` colour, for the new Look UI. Legacy ink/noir/pop values are aliased to the
 * festival rules. No radial-gradient, no dots, no halftone: colour art sits on a flat tint and under the theme's
 * wash at 35% soft-light; grey art sits on the flat wash. All gradients are linear, 145 degrees. The grade layer
 * is inside `.ct-art` only, so captions, balloons and SFX (its siblings) are never covered. */
export const lookStyles = mangaThemes.map(lookRules).join('');
