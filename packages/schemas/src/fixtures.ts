/**
 * Fixture schemas owned by the engine workstream (plan §7). Fixture schemas use
 * z.strictObject, so a field lost to a comment or typo fails loudly.
 * Mining/trial-input fixture schemas live in `trial-inputs.ts`.
 */
import { z } from 'zod';
import { RepoPath, Sha40 } from './primitives';

export const Pins = z.strictObject({
  django_sha: Sha40, // git -C $DJANGO_SRC rev-parse origin/main on Phase 0 day
  second_repo: z.enum(['cpython', 'sympy']).nullable(),
  second_sha: Sha40.nullable(),
  ts_demo: z
    .strictObject({
      repo: z.string(),
      R: Sha40,
      C: Sha40,
      file: RepoPath,
      qualname: z.string(),
      license: z.string(),
      c_file_count: z.number().int(),
    })
    .nullable(),
  demo_cases: z.array(
    z.strictObject({
      R: Sha40,
      C: Sha40,
      file: RepoPath,
      qualname: z.string(),
      c_file_count: z.number().int(),
    }),
  ),
  // null = pending: P0-04 picks the model with `kiro-cli chat --list-models` (a real run refuses null).
  model: z.string().min(1).nullable(),
  model_cutoff: z.strictObject({ date: z.string(), source_url: z.string().url() }).nullable(), // from the provider's model card
  kiro_cli_version: z.string(),
  npm_package: z.string().min(1).nullable(), // null = pending: P0-29, the maintainer decides the name
  syn_fork_base: Sha40.nullable(),
  docker_images: z.record(z.string(), z.string()),
  tools: z.record(z.string(), z.string()),
});
export type Pins = z.infer<typeof Pins>;
