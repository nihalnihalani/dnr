# How Kiro built DNR

Devpost write-up skeleton (plan §11). Every `{{…}}` value is generated from `reports/video/numbers.json` for the §9.8 row that applied, or from a file named next to it; nothing here is typed by hand once the trial is scored. Every claim links to a file in `reports/` or `.kiro/`.

## 1. Problem

> **"Your repository remembers why. Your agent doesn't."**

{{audience}}. A change that was tried and reverted looks like a reasonable cleanup to an agent that never read the ticket. Existing tests caught {{Y}} of {{X}} re-applications in our trial, and {{human_reproposals}} reverted changes were proposed again by people ([reports/human-reproposals.md](../reports/human-reproposals.md)).

![DNR blocking a re-application]({{gif_path}})

## 2. Audience and evidence

Maintainers of repositories that accept AI-agent changes. Motivation: Al Hasan and Biswas, "What Breaks When LLMs Code?" (arXiv 2605.30777), 547 confirmed coding-agent safety failures. Maintainer pilot: {{pilot_summary}} ([reports/pilot.md](../reports/pilot.md), not pre-registered).

## 3. How it works

{{pitch_mechanism}} It shows the reason and links to the original commit, the revert and the ticket. Re-landing a fixed version takes one approval.

See the diagram in [docs/architecture.md](architecture.md).

### 3a. Why Frankenstein

The human arguments in a mid-2000s bug tracker (Django's Trac), deterministic syntax trees (tree-sitter), git's revert graph and a nondeterministic 2026 agent, stitched into one write path.

### 3b. What surprised us

To be filled from build-time findings only, each with its commit or report link. Planning research (such as the mining regex correction made while writing the plan) does not go here.

- Spike findings: {{spike_findings}} ([docs/spikes.md](spikes.md)).
- The first failing property and its fix: {{first_property_failure}} ([reports/property-failures.md](../reports/property-failures.md)).
- Other build-time surprises: {{build_findings}}.

## 4. Trial

Pre-registered at tag [`prereg-v1`]({{prereg_url}}) (`{{prereg_sha}}`), labeled blind by the builder and an outside labeler, every run public.

| Arm | Landed (of {{K_eff}}) |
|---|---|
| No DNR (T) | {{X_eff}} |
| Steering file from history (S) | {{S_eff}} |
| DNR live (L) | {{W_L}} |

{{pitch_result}} κ (builder vs outside): {{kappa_builder_vs_outside}}. Held-out recall: {{held_out_recall}}. Full tables, intervals and limits: [reports/trial.md](../reports/trial.md) and the Playground's `/trial`.

## 5. How Kiro built it

One sentence per surface that exists in the repo, generated from `.kiro/` and `powers/`:

- **Specs and tasks (IDE):** {{surface_specs}} ([.kiro/specs/](../.kiro/specs/))
- **CLI hooks and headless runs:** {{surface_hooks}} ([.kiro/hooks/](../.kiro/hooks/))
- **Web and IDE (spike S14):** {{surface_web_ide}}
- **Crew bot:** {{surface_crew}}
- **Custom agents:** {{surface_agents}} ([.kiro/agents/](../.kiro/agents/), [trial/agents/](../trial/agents/))
- **Steering:** {{surface_steering}} ([.kiro/steering/](../.kiro/steering/))
- **MCP and the power:** {{surface_mcp_power}} ([.kiro/settings/mcp.json](../.kiro/settings/mcp.json), [powers/dnr/](../powers/dnr/))
- **Property tests and the failure record:** {{surface_properties}}
- **Dev hooks:** {{surface_dev_hooks}} ([.kiro/hooks/dev-core-tests-on-save.json](../.kiro/hooks/dev-core-tests-on-save.json))

## 6. Try it

- Playground: {{playground_url}}
- Offline replay: `npx {{package}} demo`
- Your repo: `npm i -g {{package}} && dnr init`
- Step-by-step: [docs/testing.md](testing.md)

## 7. Limits

From [docs/threat-model.md](threat-model.md): {{limits_summary}}
