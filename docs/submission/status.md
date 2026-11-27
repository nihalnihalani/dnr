# Submission status

Output of `scripts/submission/check.sh` (plan §11 submission checklist), run 2026-11-27T15:44Z at `4da3a51`. Re-run it to refresh this file; it exits non-zero on any FAIL.

**10 PASS, 0 FAIL, 10 PENDING.**

| Status | Row | Item | Detail |
|---|---|---|---|
| PENDING | SUB-01 | Video public on YouTube | video_url is not set in docs/submission/links.json (not uploaded yet) |
| PENDING | VID-01 | Video under 3:00 (ffprobe) | no final cut: set VIDEO_FILE=<file> to run ffprobe |
| PASS | SUB-02 | Repo is public | nihalnihalani/dnr is PUBLIC |
| PASS | SUB-02 | License is MIT (About panel) | GitHub detects mit |
| PASS | SUB-03 | git ls-files .kiro is non-empty | 21 tracked files |
| PASS | SUB-03 | .kiro is not gitignored | git check-ignore matches none of .kiro, .kiro/steering/product.md, .kiro/hooks/dnr-pre-write.json |
| PASS | SUB-04 | Playground URL returns 200, no login | https://nihalnihalani.github.io/dnr/ → 200, no redirect off-site, no password field |
| PASS | SUB-04 | /play block works (@smoke, Chromium) | 1 passed against https://nihalnihalani.github.io/dnr/ (channel chrome) |
| PASS | SUB-04 | Deep links return 200 | /play/43933a1dca /graveyard /trial /replay /kiro /orders/dnr-43933a1dca |
| PASS | SUB-05 | README.md#testing is present | README.md:37 |
| PENDING | SUB-06 | Category: Frankenstein | chosen in the Devpost form by the maintainer; not scriptable |
| PASS | SUB-08 | Every link in the README and write-up resolves | 130 link(s) in 4 file(s) resolve |
| PENDING | WRITE-03 | Pitch and write-up generated from numbers.json | current, with 22 pending item(s) |
| PENDING | VID-05 | Video captions checker | numbers: reports/video/numbers.json does not exist: `dnr trial report` has not run on real trial data |
| PENDING | SUB-07 | Bonus eligibility recorded (Phase 0) | pending (user): record which bonuses apply (Phase 0) |
| PENDING | P14-03 | Crew bonus: separate public repo with .kiro | crew_repo is not set in docs/submission/links.json (dnr-crew is local-only) |
| PENDING | P14-01 | Blog: dev.to post published | draft in docs/submission/devto-draft.md; devto_url not set (not published) |
| PASS | P14-02 | Social drafts start with #KiroweenHackathon26 | every post starts with #KiroweenHackathon26 |
| PENDING | P14-02 | Social post live (x_url) | x_url is not set in docs/submission/links.json (not posted) |
| PENDING | P14-02 | Social post live (linkedin_url) | linkedin_url is not set in docs/submission/links.json (not posted) |
