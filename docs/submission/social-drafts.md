# Social drafts (not posted)

> **Drafts. Not posted.** The maintainer posts these during the submission window, then sets `x_url` and `linkedin_url` in [links.json](links.json) (plan Phase 14, P14-02). Each post must **start with** `#KiroweenHackathon26`; `scripts/submission/verify.ts social` checks that, and that the X post fits in 280 characters. They carry no trial numbers: none exist yet. If a post should cite results, take the sentence from [pitch.md](pitch.md) once it is no longer pending. The posts say the hook stops or refuses the write, which is what the built hook does today. If the §9.8 row turns out to be D3, D5 or D6→D5, DNR ships `warn-only`, so change those verbs to "warns" before posting.

Facts used: the real Django block ([reports/orders/README.md](../../reports/orders/README.md)), the first failing property ([reports/property-failures.md](../../reports/property-failures.md)), the Playground URL ([links.json](links.json)), the repo.

## X

```text
#KiroweenHackathon26 DNR turns a repo's reverts into do-not-resurrect orders. A Kiro PreToolUse hook stops an agent's write that would re-apply a reverted change, and shows why. Our first failing property found a bug in our own test. Try it: https://nihalnihalani.github.io/dnr/
```

## LinkedIn

```text
#KiroweenHackathon26 What Kiro changed about how we built DNR (Do Not Resurrect), our Frankenstein-category entry.

DNR turns a repository's reverts into do-not-resurrect orders. A maintainer approves each one. When a Kiro agent's write would bring a reverted change back, a PreToolUse hook refuses the write before the file changes, with the reason and links to the original commit, the revert and the ticket. On a real Django revert (43933a1dca), the re-application exits 2 with edit score 1.00.

Writing the spec first changed the work. The properties in the spec ran under fast-check, and the very first failure was ours: P1's oracle wrote to a file the order doesn't cover, so the engine was right to allow it. We recorded that instead of hiding it.

Try the matcher in your browser, no login: https://nihalnihalani.github.io/dnr/
Code (MIT): https://github.com/nihalnihalani/dnr
```
