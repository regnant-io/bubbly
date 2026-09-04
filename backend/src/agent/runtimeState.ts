/**
 * Live workspace state — what is TRUE RIGHT NOW, told to the model every turn.
 *
 * THE BUG THIS EXISTS TO KILL
 *
 * A thread crossed its context limit, got summarized, and continued in a fresh
 * thread. The dev server it had started forty minutes earlier was still running,
 * still serving, still bound to port 5173 — and the new thread, whose entire
 * memory was a prose summary, started it again. Two servers, the second one
 * failing on a taken port or silently stepping to 5174, and a preview pointing
 * at whichever won. The same class of mistake reinstalls dependencies that are
 * already installed, re-authors a run config that already exists, and re-runs a
 * migration that already ran.
 *
 * The root cause is not the summarizer. A summary is a story about the past; the
 * things above are FACTS ABOUT THE PRESENT, and no amount of prose about what
 * happened will reliably carry them. They are also cheap to observe directly —
 * a process table lookup, a few stat calls — so there is no reason to make the
 * model remember them at all.
 *
 * So this module reads the live state from the systems that own it and renders
 * a compact block that is:
 *
 *   1. Appended to the system prompt on EVERY iteration of the agent loop, so it
 *      is correct mid-generation and not merely at the start of a turn. An
 *      install that finished during iteration 4 is visible in iteration 5.
 *   2. Passed into the handoff summary at migration time, so a fresh thread is
 *      born knowing what is already running.
 *
 * Everything here must stay cheap and must never throw: it runs on every single
 * model call, and a briefing that breaks the loop is worse than no briefing.
 */

import fs from 'fs';
import path from 'path';
import { backgroundProcesses } from './tools/backgroundProcess';
import { watchers } from './tools/watchers';
import { readRunConfig } from './tools/browserControl';
import { detectDrift } from './fileDrift';
import { listSpecs, nextTaskOf } from './tools/specs';
import { logger } from '../utils/logger';
import type { Spec } from '../types';

/** Directories worth checking for an install, relative to the workspace root. */
const DEP_SCAN_DIRS = ['', 'frontend', 'backend', 'client', 'server', 'web', 'api', 'app', 'apps', 'packages'];
const DEP_SCAN_DEPTH_LIMIT = 12;

export interface DependencyState {
  /** Directory relative to the workspace root ('' = root). */
  dir: string;
  installed: boolean;
  /** node_modules exists but the package manager never finished writing it. */
  partial: boolean;
}

/**
 * Which package.json directories have their dependencies installed.
 *
 * `node_modules/.package-lock.json` is npm's end-of-reify marker, so its absence
 * next to an existing node_modules means an interrupted install — the state that
 * produces "module not found" for a package the agent watched itself install.
 * Reported as `partial` rather than either true or false, because it is neither.
 */
export function scanDependencies(workspacePath: string): DependencyState[] {
  const out: DependencyState[] = [];
  const seen = new Set<string>();

  const consider = (relDir: string) => {
    if (out.length >= DEP_SCAN_DEPTH_LIMIT) return;
    const key = relDir.replace(/\\/g, '/');
    if (seen.has(key)) return;
    seen.add(key);
    const abs = path.join(workspacePath, relDir);
    if (!fs.existsSync(path.join(abs, 'package.json'))) return;
    const modules = path.join(abs, 'node_modules');
    const installed = fs.existsSync(modules);
    const partial = installed && !fs.existsSync(path.join(modules, '.package-lock.json'));
    out.push({ dir: key, installed, partial });
  };

  for (const d of DEP_SCAN_DIRS) {
    try {
      const abs = path.join(workspacePath, d);
      if (d && !fs.existsSync(abs)) continue;
      consider(d);
      // `apps/` and `packages/` are containers, not packages — look one level in.
      if (d === 'apps' || d === 'packages') {
        for (const child of fs.readdirSync(abs, { withFileTypes: true })) {
          if (child.isDirectory()) consider(path.join(d, child.name));
        }
      }
    } catch { /* an unreadable directory is simply not reported */ }
  }
  return out;
}

export interface ProjectChecks {
  /** Directory the commands must run in, relative to the workspace root. */
  dir: string;
  test: string | null;
  lint: string | null;
  typecheck: string | null;
  build: string | null;
  /** Framework/runtime we recognised, for the "run the right check" nudge. */
  stack: string | null;
}

/**
 * The verification commands this project ACTUALLY has.
 *
 * Told to the agent so "run the tests" resolves to a real command instead of a
 * plausible invention. `npm test` in a project with no test script prints npm's
 * "Missing script" error, which reads like a broken project rather than an
 * absent one — and an agent that has been instructed to prove its work will
 * then go and "fix" something that was never wrong. Reporting `test: (none)`
 * turns that into the useful signal it should be: there is no suite yet, so
 * write one as part of this change.
 */
export function detectProjectChecks(workspacePath: string, dir = ''): ProjectChecks | null {
  const abs = path.join(workspacePath, dir);
  const pkgPath = path.join(abs, 'package.json');

  if (fs.existsSync(pkgPath)) {
    let scripts: Record<string, string> = {};
    let deps: Record<string, string> = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      scripts = pkg.scripts ?? {};
      deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    } catch {
      return null;
    }
    const pm =
      fs.existsSync(path.join(abs, 'pnpm-lock.yaml')) || fs.existsSync(path.join(workspacePath, 'pnpm-lock.yaml')) ? 'pnpm'
      : fs.existsSync(path.join(abs, 'yarn.lock')) || fs.existsSync(path.join(workspacePath, 'yarn.lock')) ? 'yarn'
      : fs.existsSync(path.join(abs, 'bun.lockb')) ? 'bun'
      : 'npm';
    const run = (name: string) => (pm === 'npm' ? `npm run ${name}` : pm === 'bun' ? `bun run ${name}` : `${pm} ${name}`);

    const pick = (...names: string[]) => names.find((n) => scripts[n]) ?? null;
    const testScript = pick('test', 'test:unit', 'vitest', 'jest');
    const lintScript = pick('lint', 'eslint');
    const typecheckScript = pick('typecheck', 'type-check', 'tsc', 'check-types');
    const buildScript = pick('build');

    // TypeScript with no typecheck script still has a check — the compiler.
    const hasTs = !!deps.typescript || fs.existsSync(path.join(abs, 'tsconfig.json'));

    return {
      dir,
      test: testScript ? run(testScript) : null,
      lint: lintScript ? run(lintScript) : null,
      typecheck: typecheckScript ? run(typecheckScript) : hasTs ? 'npx tsc --noEmit' : null,
      build: buildScript ? run(buildScript) : null,
      stack: deps.next ? 'next' : deps.vite || deps['@sveltejs/kit'] ? 'vite' : deps['react-scripts'] ? 'cra' : hasTs ? 'typescript' : 'node',
    };
  }

  if (fs.existsSync(path.join(abs, 'pyproject.toml')) || fs.existsSync(path.join(abs, 'requirements.txt'))) {
    return { dir, test: 'python -m pytest', lint: 'python -m ruff check .', typecheck: 'python -m mypy .', build: null, stack: 'python' };
  }
  if (fs.existsSync(path.join(abs, 'go.mod'))) {
    return { dir, test: 'go test ./...', lint: 'go vet ./...', typecheck: 'go build ./...', build: 'go build ./...', stack: 'go' };
  }
  if (fs.existsSync(path.join(abs, 'Cargo.toml'))) {
    return { dir, test: 'cargo test', lint: 'cargo clippy', typecheck: 'cargo check', build: 'cargo build', stack: 'rust' };
  }
  return null;
}

function humanUptime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export interface RuntimeStateOptions {
  workspacePath: string;
  /** The spec this thread is working on, if any. */
  specId?: string;
  /** The thread, so its working plan can be shown back on every model call. */
  sessionId?: string;
}

/**
 * Render the live-state block. Returns '' when there is genuinely nothing to
 * report, so a fresh workspace doesn't pay for an empty section.
 */
export function buildRuntimeStateBlock(opts: RuntimeStateOptions): string {
  const sections: string[] = [];

  // --- The working plan ----------------------------------------------------
  // FIRST, deliberately. A plan that is not in front of the model is a plan the
  // model stops maintaining: twenty tool calls into a turn the original
  // update_plan call is far outside working attention, and the observable
  // result was an agent that quietly abandoned its own checklist while the UI
  // kept presenting stale progress as current. Re-stating it every call, with
  // the step ids needed to tick a box, makes forgetting it impossible.
  if (opts.sessionId) {
    try {
      const { buildPlanStateSection } = require('./planManager') as typeof import('./planManager');
      const planSection = buildPlanStateSection(opts.sessionId);
      if (planSection) sections.push(planSection);
    } catch (err) {
      logger.debug('Could not build the plan section', { error: String(err) });
    }
  }

  // --- Background processes ------------------------------------------------
  // The single most important fact: is the dev server ALREADY UP.
  try {
    const procs = backgroundProcesses.list();
    const running = procs.filter((p) => p.status === 'running');
    const recentlyDead = procs
      .filter((p) => p.status !== 'running')
      .slice(-3);

    if (running.length > 0) {
      let anyMoved = false;
      const lines = running.map((p) => {
        const bits = [`\`${p.command}\``, `id: ${p.id}`, `cwd: ${p.cwd}`, `up ${humanUptime(p.uptimeMs)}`];
        if (p.detectedUrl) bits.push(`SERVING ${p.detectedUrl}`);
        // A server that had to move ports is the single most common source of
        // "the agent is talking to the wrong address". Say so explicitly, and
        // name the address that is current, rather than leaving the agent to
        // reconcile a stale memory against a log it read ten steps ago.
        const sightings = Array.isArray(p.urlSightings) ? p.urlSightings : [];
        if (sightings.length > 1) {
          anyMoved = true;
          bits.push(`MOVED: it first announced ${sightings.slice(0, -1).join(' then ')}, and is NOW on ${p.detectedUrl}`);
        }
        if (p.awaitingInput) bits.push('WAITING FOR INPUT — answer it with send_process_input');
        return `- ${bits.join(' · ')}`;
      });
      sections.push(
        `### Already running — do NOT start these again\n${lines.join('\n')}\n` +
        `Starting a second copy of one of these binds a different port (or fails), and the preview then shows whichever won. ` +
        `To restart one, stop_process it first. To read what it has printed, get_process_output(id).` +
        (anyMoved
          ? `\nA server marked MOVED found its usual port taken and rebound itself. The LAST address listed is the live one — ` +
            `use it for every URL you open, test or write into a config, and do not reuse the first one you saw.`
          : '')
      );
    }
    if (recentlyDead.length > 0) {
      sections.push(
        `### Recently exited\n` +
        recentlyDead.map((p) => `- \`${p.command}\` (${p.id}) — ${p.status}, exit code ${p.exitCode ?? 'unknown'}`).join('\n')
      );
    }
  } catch (err) {
    logger.debug('Could not read background processes for runtime state', { error: String(err) });
  }

  // --- Detached watchers ---------------------------------------------------
  try {
    const table = watchers.describeAll();
    const live = table.filter((w) => !w.settled);
    const done = table.filter((w) => w.settled && w.outcome);
    if (live.length > 0) {
      sections.push(
        `### Waiting on\n` +
        live.map((w) => {
          const mins = Math.max(1, Math.round(w.remainingMs / 60_000));
          return `- ${w.label} (${w.id}, ${Math.round(w.ageMs / 1000)}s so far, gives up in ~${mins}m)`;
        }).join('\n') +
        `\nYou will be resumed automatically when one of these settles. Do not poll it. ` +
        `If one is about to give up on work that is clearly still healthy, watch(action:"extend", watcher_id:"...") rather than starting a second watcher.`
      );
    }
    if (done.length > 0) {
      sections.push(
        `### Finished waiting\n` +
        done.map((w) => `- ${w.label} — ${w.outcome}`).join('\n') +
        `\nCall watch(action:"collect") to read the details if you have not already.`
      );
    }
  } catch { /* watchers are optional context */ }

  // --- Dependencies --------------------------------------------------------
  try {
    const deps = scanDependencies(opts.workspacePath);
    if (deps.length > 0) {
      const lines = deps.map((d) => {
        const where = d.dir || '(root)';
        if (d.partial) return `- ${where}: node_modules exists but the install was INTERRUPTED — delete it and install again before importing anything`;
        return `- ${where}: ${d.installed ? 'dependencies installed' : 'NOT installed — run the install before building or starting'}`;
      });
      sections.push(`### Dependencies\n${lines.join('\n')}`);
    }
  } catch { /* dependency scan is best-effort */ }

  // --- Files changed under the agent ---------------------------------------
  // The user has their own editor open, a formatter runs on save, a branch
  // gets checked out. A file touched since the agent wrote it has to be
  // re-read before it is edited again, or the next edit lands on a version
  // that no longer exists — and in the worst case reverts the user's change
  // while reporting success.
  try {
    const drift = detectDrift(opts.workspacePath);
    if (drift.length > 0) {
      sections.push(
        `### Changed by someone other than you since you wrote them\n` +
        drift.map((d) => `- ${d.path} — ${d.detail}`).join('\n') +
        `\nRe-read these with read_file BEFORE editing them. Your memory of their contents is out of date, and an ` +
        `edit anchored on what you wrote will either fail to match or silently overwrite somebody else's work. ` +
        `If a change here conflicts with what you were about to do, say so rather than reverting it.`
      );
    }
  } catch { /* drift detection is best-effort */ }

  // --- Verification commands -----------------------------------------------
  try {
    const dirs = ['', ...scanDependencies(opts.workspacePath).map((d) => d.dir).filter(Boolean)];
    const checks = dirs
      .map((d) => detectProjectChecks(opts.workspacePath, d))
      .filter((c): c is ProjectChecks => c !== null)
      .slice(0, 4);
    if (checks.length > 0) {
      const lines = checks.map((c) => {
        const where = c.dir || '(root)';
        const parts = [
          `test: ${c.test ?? 'NONE — this project has no test script; add one as part of your change'}`,
          `typecheck: ${c.typecheck ?? 'none'}`,
          `lint: ${c.lint ?? 'none'}`,
          `build: ${c.build ?? 'none'}`,
        ];
        return `- ${where} (${c.stack}) — ${parts.join(' · ')}`;
      });
      sections.push(
        `### Verification commands that ACTUALLY exist here\n${lines.join('\n')}\n` +
        `Use these exact commands. Do not invent one, and do not report a missing script as a project failure.`
      );
    }
  } catch { /* check detection is best-effort */ }

  // --- Run config / preview ------------------------------------------------
  try {
    const cfg = readRunConfig(opts.workspacePath);
    if (cfg.exists && cfg.enabled) {
      const svc = (cfg.meta?.services ?? []).map((s) => `${s.name} (${s.kind}, cwd: ${s.cwd || '.'}, start: ${s.start ?? 'none'})`);
      const errors = cfg.issues.filter((i) => i.level === 'error');
      sections.push(
        `### Run config — ALREADY AUTHORED, do not rewrite it\n` +
        `Services: ${svc.length > 0 ? svc.join('; ') : '(none)'}\n` +
        `Preview URL: ${cfg.meta?.previewUrl ?? 'not known yet (it is detected from the running server)'}` +
        (errors.length > 0 ? `\nPROBLEMS that need preview_config write: ${errors.map((i) => i.message).join(' ')}` : '')
      );
    } else if (!cfg.exists) {
      sections.push(
        `### Run config — MISSING\n` +
        `Bubbly Preview is blocked until \`preview_config write\` records how this project starts. ` +
        `Do that before trying browser_control.`
      );
    }
  } catch { /* the run config gate reports its own problems */ }

  // --- Spec progress -------------------------------------------------------
  try {
    const specs = listSpecs(opts.workspacePath);
    const active: Spec | undefined = opts.specId
      ? specs.find((s) => s.id === opts.specId)
      : specs.find((s) => s.status === 'in_progress');
    if (active) {
      const done = active.tasks.filter((t) => t.status === 'done').length;
      const next = nextTaskOf(active);
      sections.push(
        `### Active spec — \`${active.id}\` (${active.title})\n` +
        `Files: .bubbly/specs/${active.id}/{requirements,design,tasks}.md · phase: ${active.phase} · ${done}/${active.tasks.length} tasks done\n` +
        (next
          ? `Next task per tasks.md: [${next.status === 'in_progress' ? '~' : ' '}] **${next.id}** ${next.title}` +
            (next.verifyWith ? `\nIt is verified with: \`${next.verifyWith}\`` : '')
          : active.tasks.length > 0 ? 'All tasks are marked done.' : 'No tasks written yet.')
      );
    } else if (specs.length > 0 && !opts.specId) {
      sections.push(
        `### Specs in this project\n` +
        specs.slice(0, 5).map((s) => `- \`${s.id}\` — ${s.title} (${s.status})`).join('\n')
      );
    }
  } catch { /* specs are optional context */ }

  if (sections.length === 0) return '';

  return (
    `\n\n---\n# LIVE WORKSPACE STATE (regenerated every turn — trust this over your memory)\n\n` +
    `Everything below was observed just now. Where it contradicts your recollection or an earlier ` +
    `message in this conversation, IT is right and the conversation is stale.\n\n` +
    sections.join('\n\n') +
    `\n---\n`
  );
}

/**
 * The same facts, condensed to a few lines for the migration handoff brief.
 *
 * A fresh thread reads this before its first action, which is the moment the
 * "start the dev server that is already running" mistake used to happen.
 */
export function buildHandoffStateNote(opts: RuntimeStateOptions): string {
  const bits: string[] = [];

  try {
    const running = backgroundProcesses.list().filter((p) => p.status === 'running');
    if (running.length > 0) {
      bits.push(
        `ALREADY RUNNING (do not start again): ` +
        running.map((p) => `\`${p.command}\` [${p.id}]${p.detectedUrl ? ` serving ${p.detectedUrl}` : ''}`).join('; ')
      );
    }
  } catch { /* ignore */ }

  try {
    const deps = scanDependencies(opts.workspacePath);
    const installed = deps.filter((d) => d.installed && !d.partial).map((d) => d.dir || '(root)');
    const missing = deps.filter((d) => !d.installed).map((d) => d.dir || '(root)');
    const partial = deps.filter((d) => d.partial).map((d) => d.dir || '(root)');
    if (installed.length > 0) bits.push(`Dependencies ALREADY INSTALLED in: ${installed.join(', ')} — do not reinstall.`);
    if (partial.length > 0) bits.push(`Dependencies PARTIALLY installed (interrupted) in: ${partial.join(', ')} — reinstall these.`);
    if (missing.length > 0) bits.push(`Dependencies NOT installed in: ${missing.join(', ')}.`);
  } catch { /* ignore */ }

  try {
    const cfg = readRunConfig(opts.workspacePath);
    if (cfg.exists) {
      bits.push(`Run config already exists at ${cfg.path}${cfg.meta?.previewUrl ? ` (preview ${cfg.meta.previewUrl})` : ''} — do not re-author it.`);
    }
  } catch { /* ignore */ }

  try {
    const specs = listSpecs(opts.workspacePath);
    const active = opts.specId ? specs.find((s) => s.id === opts.specId) : specs.find((s) => s.status === 'in_progress');
    if (active) {
      const done = active.tasks.filter((t) => t.status === 'done').length;
      const next = nextTaskOf(active);
      bits.push(
        `Spec \`${active.id}\`: ${done}/${active.tasks.length} tasks done. ` +
        (next ? `Next is **${next.id}** ${next.title}. ` : 'All tasks marked done. ') +
        `Read .bubbly/specs/${active.id}/tasks.md before doing anything.`
      );
    }
  } catch { /* ignore */ }

  return bits.join('\n');
}
