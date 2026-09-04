/**
 * Regression test for NODE_ENV leak into child processes.
 *
 * When Bubbly's backend runs with NODE_ENV=production (as it does in the
 * packaged desktop app), that MUST NOT leak into user commands. If it does,
 * `npm install` skips devDependencies in every user project.
 */

import { runShell } from './shell';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('shell environment leak prevention', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let tempDir: string;

  beforeAll(() => {
    // Create a temp directory for test workspace
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-env-test-'));
  });

  afterAll(() => {
    // Restore original NODE_ENV
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it('should NOT leak NODE_ENV=production into child processes', () => {
    // Simulate the IDE backend running in production mode
    process.env.NODE_ENV = 'production';

    const command = process.platform === 'win32' 
      ? '$env:NODE_ENV' 
      : 'echo $NODE_ENV';

    const result = runShell(command, tempDir);

    // The child should NOT see NODE_ENV=production
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).not.toBe('production');
    // On Windows PowerShell, undefined var prints nothing
    // On Unix, undefined var prints empty string
    expect(result.stdout.trim()).toBe('');
  });

  it('should NOT leak arbitrary IDE env vars into child processes', () => {
    // Set a custom env var that only exists in the IDE process
    process.env.BUBBLY_INTERNAL_SECRET = 'should-not-leak';

    const command = process.platform === 'win32'
      ? '$env:BUBBLY_INTERNAL_SECRET'
      : 'echo $BUBBLY_INTERNAL_SECRET';

    const result = runShell(command, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).not.toContain('should-not-leak');
    expect(result.stdout.trim()).toBe('');

    // Cleanup
    delete process.env.BUBBLY_INTERNAL_SECRET;
  });

  it('should pass through whitelisted env vars like PATH', () => {
    const command = process.platform === 'win32'
      ? '$env:PATH'
      : 'echo $PATH';

    const result = runShell(command, tempDir);

    expect(result.exitCode).toBe(0);
    // PATH should be set and non-empty
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('should pass through nonInteractiveEnv vars like CI', () => {
    const command = process.platform === 'win32'
      ? '$env:CI'
      : 'echo $CI';

    const result = runShell(command, tempDir);

    expect(result.exitCode).toBe(0);
    // CI should be set to '1' by nonInteractiveEnv()
    expect(result.stdout.trim()).toBe('1');
  });

  it('npm install should see clean environment (not NODE_ENV=production)', () => {
    // This is the actual bug scenario: user runs `npm install` in their project
    // and it should install devDependencies, not skip them
    process.env.NODE_ENV = 'production';

    // Simply verify that NODE_ENV isn't visible in the spawned environment
    // A more complete test would actually run npm install, but that's slow
    const command = process.platform === 'win32'
      ? 'Write-Output "NODE_ENV=$env:NODE_ENV"'
      : 'echo "NODE_ENV=$NODE_ENV"';

    const result = runShell(command, tempDir);

    // NODE_ENV should not be set (shows as empty)
    expect(result.stdout).toContain('NODE_ENV=');
    expect(result.stdout).not.toContain('NODE_ENV=production');
    // Verify it's actually empty, not just not "production"
    expect(result.stdout.trim()).toBe('NODE_ENV=');
  });
});
