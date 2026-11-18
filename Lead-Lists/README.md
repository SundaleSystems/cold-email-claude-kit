# Lead-Lists

Working folder for list builds. Everything in here except this README and the empty stage
folders is git-ignored, so lead data never ends up on GitHub.

| Folder | What lands here | Written by |
|---|---|---|
| `1-Vayne/` | Raw + normalized Sales Navigator scrapes | `/vayne-lead-pipeline` step 1 |
| `2-Lead-Magic/` | Leads with emails found | `leadmagic-find-emails.ts` |
| `3-Million-Verifier/` | Verification results (all statuses) | `/millionverifier` |
| `4-Final-Lead-Lists/` | Send-ready, ok-only CSV + scorecard | `/vayne-lead-pipeline` final step |

Keep the raw Vayne export: it has revenue-range data you can filter on before paying for
emails (see `docs/lessons-learned.md`).
