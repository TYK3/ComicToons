# Generated verification output

Gate runs write screenshots, accessibility reports, traces, replay reports, PNG comparisons, performance observations and temporary test directories here. These files are local output, not versioned fixtures. Running checks must not dirty the checkout just because an image or report changes.

Regenerate with:

- `npm test`: unit-test scratch directories under `artifacts/tmp/`.
- `npm run e2e`: browser screenshots and reports in the named feature directories; Playwright traces under `artifacts/playwright/`.
- `npm run test:chaos`: ingest screenshots and bounded-state observations under `artifacts/ingest-chaos/`.
- `npm run test:twitch`: loopback mock-harness output and scratch files.
- `node scripts/s2-replay.mjs`: offline replay report under `artifacts/tmp/`.
- `npm run gate`: complete verification; the manager owns this run.

Feature tests create their output directories and write comparison PNGs before reading them. The unit runner and browser configuration create `artifacts/tmp/`; the clean-directory build also creates it. No test fixture depends on a tracked screenshot or historical report here. Original art and input fixtures remain under `fixtures/`.

Two historical baseline screenshots are curated under [docs/evidence](../docs/evidence/): [desktop](../docs/evidence/baseline-dashboard-1440x900.png) and [phone](../docs/evidence/baseline-dashboard-390x844.png). They are static review references, never gate output. Other historical document links lead here because their generated output is no longer versioned; rerunning current checks does not recreate historical measurements exactly.

Untracking output removes it from the Git index only. Existing local files are preserved. Future generated files are ignored automatically; do not force-add them. Add a deliberately curated, immutable reference under `docs/evidence/` when review requires one.
