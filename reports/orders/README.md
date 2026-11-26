# Demo orders (drafts)

Built on November 26, 2026 with `dnr orders build --from <candidates> --git-dir ../dnr-work/django --out-dir reports/orders`. Both use the default config, so `test_globs` excludes `tests/**`. Both are still **draft** with placeholder reasons (the revert subject). They become approved and drafted in Phases 4 and 8.

| Order | Original C | Units | w(A) + w(R) | ≥ min_order_weight (8) |
|---|---|---|---|---|
| `dnr-43933a1dca` | `ea3a71c2d0` (Fixed #26434) | 1: `django/db/models/sql/query.py` `Query.clear_ordering` (modified, \|A\| = 31 tokens, w(A) = 16, w(R) = 0) | 16 | yes |
| `dnr-d0e4dd5cdd` | `0246f47888` (Fixed #36546) | 18 units in 6 files (`contrib/auth/__init__.py` ×5, `contrib/auth/hashers.py` ×5, `contrib/auth/tokens.py` ×2, `core/signing.py` ×2, `middleware/csrf.py` ×2, `utils/crypto.py` ×2) | 77 | yes |

Findings:
- **43933a1dca changes `Query.clear_ordering`, not `Query.set_group_by`.** C added an `or (isinstance(self.group_by, tuple) and not {…}.issubset(self.group_by))` clause to the early-return guard, and R removed it. The §6 stderr example in 03-architecture.md names `Query.set_group_by` and is wrong for this revert. The real block message says `in Query.clear_ordering`.
- 43933a1dca is **additions-only** (R = []), so the two-sided rule holds trivially. An exact re-application scores edit 1.00. The test change in C (`tests/aggregation_regress/tests.py`) is excluded by `test_globs`.
- Django later re-landed a fixed version of #26434 (`2ce5cb0f7a`). On a checkout at Django's current HEAD, this order may therefore derive as **re-landed** and only warn. The demo must run on a checkout at the revert (`make-demo-checkout.sh`), and `pins.json` `demo_cases` should pin that.
- d0e4dd5cdd spans many small units. Most have w = 3 (`secrets.compare_digest` → `constant_time_compare` call swaps plus the import lines). The whole-order rule means a re-application blocks only when enough of the 6 files are re-applied together in one session (§5.5). Its hard negative (a docstring edit of `constant_time_compare`) replays to a warn, not a block.

End-to-end block (also the `R1:` test in `packages/hook/test/golden.test.ts`, which runs when the Django clone is present): on a Django checkout at `43933a1dca` with the order approved, `dnr check --stdin --hook kiro < fixtures/hook-events/reapply-43933a1dca.json` exits **2**, and stderr is 705 characters:

```
DNR: Reverted "Fixed #26434 -- Removed faulty clearing of ordering field when missing from explicit grouping." https://github.com/django/django/commit/43933a1dca07047e95ec990d9289d0212668009e
DNR order dnr-43933a1dca matched (edit 1.00 ≥ 0.60) in Query.clear_ordering. Original: https://github.com/django/django/commit/ea3a71c2d09f8281d8a50ed20e40e1fb13db5cd9. Ticket: https://code.djangoproject.com/ticket/26434.
This change was tried and reverted. Do not re-apply it or route around this block. Tell the user. Only a human maintainer, not the agent, can approve a re-land: `dnr board --open dnr-43933a1dca` or `dnr allow dnr-43933a1dca`, which both need a terminal and refuse inside an agent session.
```
