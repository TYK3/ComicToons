# M1 quality and threat review

## Acceptance evidence

`tests/demo.spec.ts` exercises the dashboard replay and approval controls, observes the separate OBS overlay, ends the stream, opens the recap, verifies the downloaded PNG signature and size, and verifies that the panic action clears the overlay. Screenshots are written to `artifacts/` during a passing browser run. See `STATE.md` for executed command results; test implementation alone is not proof of a passing run.

Core tests cover the three invented fixture durations, golden moment selection, replay timing, invalid speed/window rejection, opt-out precedence, prompt boundaries, email redaction, and absence of lettering/scripts/remote images in original vector artwork. Contract tests exercise recorded-shape chat and raid envelopes, plus unsupported frames.

## Boundaries and known gaps

- The deterministic mock writer uses authored captions. It does not generate arbitrary chat text and does not demonstrate real model moderation.
- `safeText` is a small local hygiene helper, not a comprehensive PII or abuse filter. Production safety and provider schema enforcement remain later work.
- The EventSub normalizer is a contract seed. OAuth, subscriptions, reconnects, refresh, deduplication, and live-session tests remain unimplemented.
- Local mutation endpoints assume a trusted single-user loopback environment. Public hosting requires authentication and request-origin protections.
- M1 exports need the Chromium runtime. A clean-machine acceptance run must include browser provisioning; cached browser availability must not be mistaken for a fresh-clone pass.
- Multi-hour stability, high-volume chat, full accessibility audit, and production dependency risk review remain pending.
