# Team lanes for M1

Four execution slots are available, so the nine requested specialist roles share three delegated lanes plus the lead. All edits stay within these lanes; agents report cross-lane fixes to the owner. Work is integrated in the shared workspace rather than isolated branches per agent.

| Role | Agent lane | File ownership |
| --- | --- | --- |
| Tech Lead | root | Root tooling, `apps/server/**`, `scripts/**`, `STATE.md`, `BACKLOG.md`, integration |
| Twitch Integration Engineer | pipeline | `packages/core/**`, `fixtures/**`; M1 recorded envelope normalization |
| AI Pipeline Engineer | pipeline | `packages/core/**`, `fixtures/**` |
| Image & Art Engineer | pipeline | `packages/core/**`, `fixtures/art/**` |
| Frontend (Overlay) | frontend | `apps/web/**` |
| Frontend (Dashboard & Recap) | frontend | `apps/web/**` |
| Design Director | QA/docs, independent of implementation | Screenshot inspection and `docs/DESIGN_REVIEW.md`; frontend owns resulting code fixes |
| QA Engineer | QA/docs | `tests/**`, browser evidence in `artifacts/**` |
| Critic / Red Team | QA/docs | `tests/**`, `docs/QA_REVIEW.md` |
| Docs & DevRel | QA/docs | `README.md`, `docs/**` except `docs/SPEC.md` |

No agent pushes to a remote. Any commit must use the repository-mandated author identity; agents did not change Git configuration.
