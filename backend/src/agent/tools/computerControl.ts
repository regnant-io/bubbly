/**
 * Computer control (PyAutoGUI) — lets a capable model drive the mouse, keyboard
 * and screen so it can operate a browser or any desktop app.
 *
 * This is the most powerful — and most dangerous — capability in Bubbly, so it
 * is wrapped in layered guardrails:
 *
 *   1. OPT-IN: it does nothing unless the `computerControlEnabled` setting is
 *      explicitly turned on. Off by default. The agent cannot move the mouse
 *      without the user enabling this first.
 *   2. APPROVAL: every action that changes anything (click, type, key, scroll,
 *      drag) requires human approval. Read-only observation (screenshot,
 *      screen_size) does not, so the agent can "see" to plan its next approved
 *      action.
 *   3. FAILSAFE: PyAutoGUI's built-in corner failsafe stays on — slam the mouse
 *      to a screen corner to abort. A short pause is enforced between actions.
 *   4. GRACEFUL DEGRADATION: if Python or pyautogui isn't installed we return a
 *      precise, actionable message instead of throwing.
 *
 * Execution shells out to a self-contained Python helper (written once to the
 * OS temp dir). We never embed user/model strings into Python source — the
 * action is passed as a single JSON argv item the script parses — so there is
 * no Python-injection surface.
 */

import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting } from '../../db/index';
import { logger } from '../../utils/logger';

export type ComputerAction =
  | 'screenshot'
  | 'screen_size'
  | 'move'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'drag'
  | 'type'
  | 'key'
  | 'scroll';

/** Actions that only OBSERVE the screen — safe to run without approval. */
export const READ_ONLY_ACTIONS: ReadonlySet<ComputerAction> = new Set(['screenshot', 'screen_size']);

export function isComputerControlEnabled(): boolean {
  return getSetting('computerControlEnabled') === 'true';
}

export interface ComputerActionParams {
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  keys?: string | string[];
  amount?: number;
  button?: 'left' | 'right' | 'middle';
}

/**
 * Validate an action + its params BEFORE doing anything. Pure and testable.
 * Returns a normalized, safe param object or an error.
 */
export function validateComputerAction(
  action: string,
  params: ComputerActionParams
): { ok: true; action: ComputerAction; params: ComputerActionParams } | { ok: false; error: string } {
  const valid: ComputerAction[] = [
    'screenshot', 'screen_size', 'move', 'click', 'double_click', 'right_click', 'drag', 'type', 'key', 'scroll',
  ];
  if (!valid.includes(action as ComputerAction)) {
    return { ok: false, error: `Unknown computer action "${action}". Valid: ${valid.join(', ')}.` };
  }
  const a = action as ComputerAction;
  const p: ComputerActionParams = {};

  const needsCoords = a === 'move' || a === 'drag';
  const coordOk = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000;

  if (needsCoords) {
    if (!coordOk(params.x) || !coordOk(params.y)) {
      return { ok: false, error: `${a} requires numeric x and y screen coordinates.` };
    }
    p.x = params.x; p.y = params.y;
  } else if (params.x != null || params.y != null) {
    // Optional coords for click/double_click/right_click (click at point).
    if (!coordOk(params.x) || !coordOk(params.y)) {
      return { ok: false, error: `x and y must be non-negative numbers.` };
    }
    p.x = params.x; p.y = params.y;
  }

  if (a === 'drag') {
    if (!coordOk(params.toX) || !coordOk(params.toY)) {
      return { ok: false, error: `drag requires numeric toX and toY destination coordinates.` };
    }
    p.toX = params.toX; p.toY = params.toY;
  }

  if (a === 'type') {
    if (typeof params.text !== 'string' || params.text.length === 0) {
      return { ok: false, error: 'type requires a non-empty "text" string.' };
    }
    if (params.text.length > 5000) {
      return { ok: false, error: 'type text is too long (max 5000 chars).' };
    }
    p.text = params.text;
  }

  if (a === 'key') {
    const keys = Array.isArray(params.keys) ? params.keys : (typeof params.keys === 'string' ? [params.keys] : []);
    if (keys.length === 0 || keys.some((k) => typeof k !== 'string' || k.length === 0)) {
      return { ok: false, error: 'key requires "keys": a key name or array of key names (e.g. "enter", ["ctrl","c"]).' };
    }
    if (keys.length > 5) return { ok: false, error: 'Too many keys in one combination (max 5).' };
    p.keys = keys;
  }

  if (a === 'scroll') {
    if (typeof params.amount !== 'number' || !Number.isFinite(params.amount)) {
      return { ok: false, error: 'scroll requires a numeric "amount" (positive = up, negative = down).' };
    }
    p.amount = Math.max(-5000, Math.min(5000, params.amount));
  }

  if (params.button) {
    if (!['left', 'right', 'middle'].includes(params.button)) {
      return { ok: false, error: 'button must be left, right, or middle.' };
    }
    p.button = params.button;
  }

  return { ok: true, action: a, params: p };
}

// The Python helper. Reads one JSON action from argv[1], performs it, prints a
// single JSON line. No model/user text is ever interpolated into this source.
const HELPER_SOURCE = `# Bubbly computer-control helper (auto-generated)
import sys, json, base64, tempfile, os
def out(obj):
    sys.stdout.write(json.dumps(obj)); sys.stdout.flush()
try:
    import pyautogui
except Exception as e:
    out({"ok": False, "error": "pyautogui_not_installed", "detail": str(e)}); sys.exit(0)
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05
try:
    act = json.loads(sys.argv[1])
    a = act.get("action"); p = act.get("params", {})
    if a == "screen_size":
        w, h = pyautogui.size(); out({"ok": True, "width": w, "height": h})
    elif a == "screenshot":
        path = os.path.join(tempfile.gettempdir(), "bubbly_screen.png")
        img = pyautogui.screenshot(); img.save(path)
        out({"ok": True, "path": path, "width": img.width, "height": img.height})
    elif a == "move":
        pyautogui.moveTo(p["x"], p["y"], duration=0.2); out({"ok": True})
    elif a in ("click", "double_click", "right_click"):
        btn = p.get("button", "right" if a == "right_click" else "left")
        kw = {"button": btn}
        if "x" in p and "y" in p: kw["x"] = p["x"]; kw["y"] = p["y"]
        if a == "double_click": pyautogui.doubleClick(**kw)
        else: pyautogui.click(**kw)
        out({"ok": True})
    elif a == "drag":
        pyautogui.moveTo(p["x"], p["y"]); pyautogui.dragTo(p["toX"], p["toY"], duration=0.3, button=p.get("button", "left"))
        out({"ok": True})
    elif a == "type":
        pyautogui.typewrite(p["text"], interval=0.01); out({"ok": True})
    elif a == "key":
        keys = p["keys"]
        if len(keys) == 1: pyautogui.press(keys[0])
        else: pyautogui.hotkey(*keys)
        out({"ok": True})
    elif a == "scroll":
        pyautogui.scroll(int(p["amount"])); out({"ok": True})
    else:
        out({"ok": False, "error": "unknown_action"})
except Exception as e:
    out({"ok": False, "error": "exception", "detail": str(e)})
`;

let cachedPython: string | null | undefined;

/** Find a usable python executable (python, then python3). Cached. */
function findPython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  for (const cmd of ['python', 'python3']) {
    try {
      const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
      if (r.status === 0 || (r.stdout + r.stderr).toLowerCase().includes('python')) {
        cachedPython = cmd;
        return cmd;
      }
    } catch { /* try next */ }
  }
  cachedPython = null;
  return null;
}

function helperPath(): string {
  const p = path.join(os.tmpdir(), 'bubbly_computer_control.py');
  try {
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== HELPER_SOURCE) {
      fs.writeFileSync(p, HELPER_SOURCE, 'utf8');
    }
  } catch { /* best effort; spawn will surface a clear error */ }
  return p;
}

export interface ComputerActionResult {
  ok: boolean;
  result: string;
  /** For screenshots: absolute path + dimensions so a vision model can read it. */
  screenshotPath?: string;
}

/** Execute a validated action via the Python helper. */
export async function runComputerAction(
  action: ComputerAction,
  params: ComputerActionParams
): Promise<ComputerActionResult> {
  if (!isComputerControlEnabled()) {
    return { ok: false, result: 'Computer control is disabled. Enable it in Settings → Safety before using computer_control.' };
  }
  const python = findPython();
  if (!python) {
    return { ok: false, result: 'Python was not found on PATH. Install Python 3 and `pip install pyautogui` to use computer control.' };
  }
  const script = helperPath();
  const payload = JSON.stringify({ action, params });

  return new Promise<ComputerActionResult>((resolve) => {
    const child = spawn(python, [script, payload], { windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 30000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, result: `Failed to launch computer control: ${err.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      let parsed: any = null;
      try { parsed = JSON.parse(stdout.trim().split('\n').pop() || ''); } catch { /* fall through */ }
      if (!parsed) {
        return resolve({ ok: false, result: `Computer control returned no parseable result.${stderr ? ` (${stderr.slice(0, 200)})` : ''}` });
      }
      if (parsed.error === 'pyautogui_not_installed') {
        return resolve({ ok: false, result: 'pyautogui is not installed. Run `pip install pyautogui` (and `pillow` for screenshots), then try again.' });
      }
      if (!parsed.ok) {
        return resolve({ ok: false, result: `Computer action failed: ${parsed.error || 'unknown'}${parsed.detail ? ` — ${parsed.detail}` : ''}` });
      }
      if (action === 'screen_size') {
        return resolve({ ok: true, result: `Screen size: ${parsed.width}x${parsed.height}` });
      }
      if (action === 'screenshot') {
        logger.info('Computer control screenshot taken', { path: parsed.path });
        return resolve({ ok: true, result: `Screenshot saved (${parsed.width}x${parsed.height}) at ${parsed.path}`, screenshotPath: parsed.path });
      }
      resolve({ ok: true, result: `Done: ${action}.` });
    });
  });
}
