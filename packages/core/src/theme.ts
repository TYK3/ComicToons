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
    blurb: 'Vivid natural colours, turquoise scenery and golden highlights.',
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
    blurb: 'Orange skies, terracotta scenery and golden light; natural character colours.',
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
    blurb: 'Blue scenery, cyan skies and turquoise light; natural character colours.',
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
    blurb: 'Lavender scenery, pink skies and mint accents; natural character colours.',
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

/** Palettes style page furniture; artwork selects a painted variant and is never filtered. */
export const mangaThemeStyles = mangaThemes.map(({id,palette}) => `
.manga-pages[data-manga-theme=${id}] .manga-page{background:${palette.paper};color:${palette.ink}}
.manga-pages[data-manga-theme=${id}] .panel-art>img{filter:none;mix-blend-mode:normal}
.manga-pages[data-manga-theme=${id}] .panel-art::after{content:none}
.manga-pages[data-manga-theme=${id}] .story-balloon{background:${palette.balloon.fill};color:${palette.balloon.text};border-color:${palette.ink}}
`).join('');

export const lookStyles = mangaThemes.map(({id,palette}) => `
.ct-art[data-look=${id}]{background:${palette.paper}}
.ct-art[data-look=${id}]>img{filter:none;mix-blend-mode:normal}
.ct-art[data-look=${id}]::after{content:none}
.ct-panel[data-look=${id}]{background:${palette.paper}}
.ct-panel[data-look=${id}] .ct-sfx{color:${palette.sfx};-webkit-text-stroke-color:${palette.sfxStroke ?? palette.ink}}
`).join('');
