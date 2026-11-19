# UI dependency review — 2026-10-27

Scope: only the Owner-requested accessible controls, icon set, local fonts and accessibility test tooling were added. Exact resolutions are recorded in package-lock.json. Review used npm registry version/license/time.modified metadata, upstream license sources and installed package license files. No runtime CDN requests are needed.

| Direct addition | Resolved version | License | Registry last modified | Purpose / decision |
| --- | --- | --- | --- | --- |
| @radix-ui/react-dialog | 1.3.1 | MIT | 2026-10-14 | Focus-trapped caption editor; accepted |
| @radix-ui/react-tooltip | 1.4.1 | MIT | 2026-10-14 | Accessible control hints; accepted |
| @radix-ui/react-toggle | 1.2.1 | MIT | 2026-10-14 | Approval state control; accepted |
| @radix-ui/react-tabs | 1.2.1 | MIT | 2026-10-14 | Keyboard-accessible art directions; accepted |
| @radix-ui/react-toast | 1.3.1 | MIT | 2026-10-14 | Live feedback and undo; accepted |
| lucide-react | 1.62.0 | ISC | 2026-10-27 | Consistent tree-shaken icons; accepted |
| @fontsource/barlow-condensed | 5.3.0 | OFL-1.1 | 2026-07-19 | Bundled display font; explicitly requested OFL font exception |
| @fontsource/dm-sans | 5.3.0 | OFL-1.1 | 2026-07-19 | Bundled text font; explicitly requested OFL font exception |
| @fontsource/bangers | 5.3.0 | OFL-1.1 | 2026-07-19 | Bundled comic display font (headings, SFX); OFL font exception |
| @fontsource/comic-neue | 5.3.0 | OFL-1.1 | 2026-07-19 | Bundled lettering font (speech balloons); OFL font exception |
| @fontsource/space-grotesk | 5.3.0 | OFL-1.1 | 2026-07-19 | Bundled interface font (reader and controls); OFL font exception |
| @axe-core/playwright | 4.14.0 | MPL-2.0 | 2026-10-15 | Explicitly requested axe test checker; test-only license exception |

These modification dates support active maintenance at review time, rather than guaranteeing future maintenance. Radix packages are published by the same maintained primitives project. Lucide has current icon releases; Fontsource's selected fonts have current self-hosted packages. Versions are locked for repeatable installation.

The application libraries meet the Owner's MIT/ISC permissive-license rule. All five bundled fonts (Barlow Condensed, DM Sans, Bangers, Comic Neue and Space Grotesk) use the SIL Open Font License (`OFL-1.1` in each package's `package.json`). Axe's wrapper and transitive `axe-core` engine are MPL-2.0 rather than MIT/ISC/Apache: they are the specifically requested accessibility checker, remain development/test-only, and are not imported into the production app. Their source and license notices remain in npm packages. No other new framework, animation library, font loader, or asset dependency was introduced.

Fonts are imported from local npm CSS; Vite emits local WOFF2 assets. The standalone exported issue embeds the same local font bytes and includes `FONT-LICENSES.txt` alongside its HTML and PNG. Original comic artwork remains project-created CC0; SFX and dialogue remain HTML text.

`npm install` completed after both batches with **0 vulnerabilities**. The complete `npm run gate` includes a fresh `npm audit --audit-level=high` at final integration; final executed results are recorded in STATE.md. Existing transitive `cookie@2.0.1` and new test-only axe4.14 declare Node22 requirements while this workspace runs Node20.19.2. Node22.12+ is recommended; actual test execution on this workspace is recorded, not inferred from engine metadata.

Primary references: [Radix MIT license](https://github.com/radix-ui/primitives/blob/main/LICENSE), [Lucide ISC license](https://github.com/lucide-icons/lucide/blob/main/LICENSE), [Fontsource packages](https://github.com/fontsource/font-files), [axe npm license](https://github.com/dequelabs/axe-core-npm/blob/develop/LICENSE). Per-package registry metadata was checked with `npm view <package> version license time.modified --json`; installed font `LICENSE` files provide the actual OFL text.
