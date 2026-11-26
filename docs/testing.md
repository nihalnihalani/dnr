# Testing DNR

These are the steps in [README#testing](../README.md#testing), with what each one needs and what you should see. Phase 13 acceptance runs all five on a clean devcontainer.

## 1. Hosted Playground (no install)

Open {{playground_url}} and choose **Try a revert**, then a demo case on `/play/:case`.

- Pick the **Original change** preset and press **Send write**: the decision panel shows **BLOCK**, exit code 2, the exact stderr text and the edit score.
- Pick **Hard negative** or **Formatting only**: the decision is **ALLOW** (or **WARN** once for a covered, non-matching edit).
- **Allow once**, then send the original change again: **ALLOW** (grant). **Advance 1 h**: the grant expires and the block returns.

Everything runs in your browser; nothing is sent anywhere.

## 2. Live Kiro block

Needs Node 24, git, uv, jq, `kiro-cli` 3.4 or later and a Kiro login.

```bash
scripts/demo/make-demo-checkout.sh        # clones Django into ../django-demo at 43933a1dca, builds the env, runs dnr init
kiro-cli login
cd ../django-demo && kiro-cli chat "$(cat "$OLDPWD/scripts/demo/prompts/write.txt")"
```

`write.txt` asks the agent to write the reverted version of `Query.set_group_by` with its file tool, so it always reaches the hook: the write is refused with a message that starts `DNR:` and names `dnr-43933a1dca`. The alternates are `direct.txt` (the direct request; measured block rate {{demo_lu_block_rate}}) and `cleanup.txt` (the cleanup task; measured block rate {{demo_l_block_rate}}).

## 3. Codespaces devcontainer

Open the repository in a Codespace (or a local devcontainer). It installs pnpm dependencies, builds and links `dnr`, uv and `kiro-cli`. Then:

```bash
dnr doctor
```

Every check is green: node, git, the grammar ABI, the hook JSON, `dnr` on the PATH hooks see, the kiro-cli version, and the board port.

## 4. Offline terminal replay

```bash
npx {{package}} demo
```

Replays the recorded demo block from bundled fixtures. Needs no Kiro, no network and no Django.

## 5. Your own repository

```bash
npm i -g {{package}}
dnr init
dnr scan
dnr orders build
dnr draft --all
dnr board
```

`dnr scan` finds the reverts in your history, `dnr orders build` turns them into draft orders, `dnr draft --all` writes a one-sentence reason for each, and you review and approve them on the board. Only approved orders are enforced.

## Developer checks

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:fixtures
```
