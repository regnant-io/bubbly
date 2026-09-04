import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { backgroundProcesses } from '../agent/tools/backgroundProcess';
import { getAllSettings } from '../db/index';
import { logger } from '../utils/logger';

/**
 * Background processes over REST.
 *
 * WHY THIS EXISTS
 *
 * The agent has been able to start a dev server, read its logs and stop it
 * since the beginning — but only through a tool call, which means only while a
 * turn is running. A person at a terminal had no equivalent: `bubbly` could
 * talk to the agent about a server it could not itself see, and starting one by
 * hand meant tying it to a terminal window that then had to stay open.
 *
 * These endpoints put the SAME process table behind a URL. A process started
 * here lives in the backend, so it survives the CLI exiting, the terminal
 * closing and the desktop window being shut — and it is the identical table the
 * agent reads, so `bubbly bg list` and the agent's `list_processes` can never
 * disagree about what is running.
 *
 * Everything here is deliberately thin. The rules about what may be run, how
 * output is buffered and how a process tree is killed all live in
 * backgroundProcess.ts, and duplicating any of them here would be a second
 * place for them to be wrong.
 */
export const processesRouter = Router();

function resolveCwd(given: unknown): string {
  const raw = typeof given === 'string' && given.trim() ? given.trim() : getAllSettings().workspacePath;
  if (!raw) throw new Error('No working directory: pass cwd, or set a workspace in Settings.');
  const abs = path.resolve(raw);
  if (!fs.existsSync(abs)) throw new Error(`No such directory: ${abs}`);
  return abs;
}

processesRouter.get('/', (_req, res) => {
  res.json({ processes: backgroundProcesses.list() });
});

processesRouter.post('/', (req, res) => {
  try {
    const command = String(req.body?.command ?? '').trim();
    if (!command) return res.status(400).json({ error: 'command is required' });
    const cwd = resolveCwd(req.body?.cwd);
    const r = backgroundProcesses.start(command, cwd);
    if (r.error) return res.status(400).json({ error: r.error });
    logger.info('Background process started over REST', { id: r.id, command, cwd, reused: r.reused });
    // `reused` matters to the caller: "started" and "there was already one of
    // these" call for different words on the terminal, and silently reporting
    // the second as the first is how people end up hunting for a process they
    // think they just created.
    res.json({ id: r.id, reused: r.reused, command, cwd });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

processesRouter.get('/:id/output', (req, res) => {
  const full = req.query.full === 'true' || req.query.full === '1';
  const r = backgroundProcesses.getOutput(String(req.params.id), { full });
  if (!r.ok) return res.status(404).json({ error: `No background process with id ${req.params.id}` });
  res.json({ output: r.output ?? '', status: r.status, exitCode: r.exitCode ?? null });
});

processesRouter.post('/:id/input', (req, res) => {
  const input = String(req.body?.input ?? '');
  const r = backgroundProcesses.sendInput(String(req.params.id), input);
  if (!r.ok) return res.status(400).json({ error: r.error ?? 'Could not send input' });
  res.json({ ok: true });
});

processesRouter.delete('/:id', (req, res) => {
  const r = backgroundProcesses.stop(String(req.params.id));
  if (!r.ok) return res.status(404).json({ error: r.error ?? 'Could not stop that process' });
  res.json({ ok: true });
});

/**
 * Stop everything.
 *
 * "One command to stop" was the actual request, and it is the right shape: the
 * whole point of leaving servers running in the background is that you stop
 * thinking about them, and by the time you want them gone you no longer
 * remember how many there were or what they were called.
 */
processesRouter.delete('/', (_req, res) => {
  const running = backgroundProcesses.list().filter((p) => p.status === 'running');
  let stopped = 0;
  for (const p of running) {
    const r = backgroundProcesses.stop(p.id);
    if (r.ok) stopped++;
  }
  logger.info('Stopped every background process on request', { stopped });
  res.json({ ok: true, stopped });
});
