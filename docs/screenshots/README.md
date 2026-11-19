# Current documentation screenshots

Captured on 3 November 2026 from the local working tree using isolated Playwright services. All story content is Sample data. The connection screen deliberately mocks an unconfigured Twitch application. These images do not establish successful real Twitch capture, paid generation or OBS broadcast quality.

| File | View |
| --- | --- |
| [studio-current.jpg](studio-current.jpg) | Sample Studio, guided replay paused after four released scenes |
| [landing-current.jpg](landing-current.jpg) | Landing page with Sample and Live entry points |
| [audience-current.jpg](audience-current.jpg) | Desktop audience view with expanded interactions |
| [audience-mobile-current.jpg](audience-mobile-current.jpg) | Phone newcomer/catch-up view |
| [library-current.jpg](library-current.jpg) | Full Library page with a saved Sample issue and reader actions |
| [output-current.jpg](output-current.jpg) | Bound Sample issue and reading-format choices |
| [reader-current.jpg](reader-current.jpg) | Manga reader with integrated lettering |
| [connect-current.jpg](connect-current.jpg) | Connection setup before configuring a Twitch app |

Desktop captures are 1242 pixels wide; the phone capture is 390 pixels wide. JPEGs are stored here so a source archive includes README images. Older `*-1280.png` images are historical and are no longer referenced by the main README.

The local capture harness is `artifacts/tmp/readme-shots.spec.ts`, configured by `artifacts/tmp/readme-shots.config.ts`. It runs on API 4405 / web 4375 with the repository's credential scrubbing and loopback network guard. Its files and logs are ignored local evidence, not prerequisites for installing the app. A checkout without that harness can reproduce the views manually using the [Sample walkthrough](../../README.md#-sample-demo).

Capture the actual app, retain visible Sample labels and navigation, exclude keys/account tokens, and inspect lettering and controls before replacing an image. Avoid artificial mockups as evidence of implemented behavior.
