# Integration fidelity repairs

## Item 1: t11.patch

Restored forgetUser at both Studio opt-out entry points alongside B2's predicate-based pruning. The former also clears baseline entries that have aged out of the short windows. Extra hunks purge opted-out content from moment snapshots and caption caches because the requested regression checks every retained content store. The permanent privacy ledger remains intact.

Validation: `INT-FID-T11: five lines then 30s gap and opt-out purge every content store (irc)` and its `(bus)` counterpart. Typecheck/lint pass; unit files 58/64 pass, with six existing sandbox socket/archive-output failures.

## Item 2: t12.patch and f4.patch

Restored a mock-Helix 403 hand-over integration test alongside the signed-in fetch-stub test. It uses the current participation plugin bus hand-over seam, then verifies createCustomReward is attempted, chat fallback drafts and moderator approval succeeds. Restored the exact 19-panel assertion in F4-LIB-01 while retaining every tag-per-kind check. Extra test scaffolding avoids the newer app auth transition replacing the explicitly handed-over mock.

Validation: `INT-FID-T12-MOCK-403: mock Helix hand-over preserves the passed non-Affiliate chat fallback`; `F4-LIB-01: library-only replay: every moment kind gets library art tagged for that kind`. Typecheck/lint pass; units 58/64 files pass with six known sandbox failures.

## Item 3: b2-r2.patch

Added explicit coverage for unmanaged Studio bus liveness and the app's managed ChatSource path, including a bus moment in each. The managed option remains an app boundary choice, not another transport selector. The Look enum in app.ts is unchanged.

ID audit: IRC PRIVMSG ids are optional when the id tag is missing. EventSub chat uses the message id or notification-id fallback. The current sample fixtures and supplied synthetic replay assign ids, but StreamEvent.id and the direct replay adapter contract remain optional. Added user/text/time keys for id-less draft lines and moment snapshots; targeted user clears remove those records without opting the user out. Extra code records event time in chat drafts and reconciles affected panels/captions/undo, because deletion by message id alone cannot find these lines.

Validation: `INT-FID-B2-STANDALONE: unmanaged Studio retains connected and disconnected bus liveness`; `INT-FID-B2-MANAGED: app ChatSource alone drives liveness and admitted bus moments`; `INT-FID-B2-IDLESS: user clears withdraw id-less chat by user text and time without opting out`. Typecheck/lint pass; units 59/65 files pass with six known sandbox failures.

## Item 4: t12.patch

Added explicit regressions for the previously accepted extra behavior: an ink request never clears the Studio opt-out ledger, and bare/yes/no ink commands (including tab-separated forms) return before moment ingestion. Both IRC and bus paths are covered. A one-message spike threshold makes accidental command ingestion observable. No new production behavior in this item.

Validation: `INT-FID-T12-OPTED-OUT: !ink never re-admits an opted-out viewer (irc)` / `(bus)` and `INT-FID-T12-COMMANDS: ink command lines never enter moment windows or panels (irc)` / `(bus)`. Typecheck/lint pass; units 60/66 files pass with the same six sandbox socket/archive-output failures. No browser suite, full gate or live calls.
