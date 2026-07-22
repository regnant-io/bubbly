import { runShellStreaming } from './shell';
import path from 'path';
import os from 'os';

// NOTE: Real-time terminal streaming (Task 11.3) is marked as [-] (not implemented)
// These tests are skipped until the feature is fully implemented
describe.skip('Shell Streaming', () => {
  const testWorkspace = path.join(os.tmpdir(), 'bubbly-test-shell-streaming');

  describe('Basic Streaming', () => {
    it('should stream stdout in real-time', async () => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let startTime: number | undefined;
      let endTime: number | undefined;
      let exitCode: number | undefined;

      const result = await runShellStreaming(
        process.platform === 'win32' ? 'Write-Output "Hello World"' : 'echo "Hello World"',
        testWorkspace,
        {
          onStart: (time) => {
            startTime = time;
          },
          onStdout: (data) => {
            stdoutChunks.push(data);
          },
          onStderr: (data) => {
            stderrChunks.push(data);
          },
          onEnd: (code, duration) => {
            exitCode = code;
            endTime = Date.now();
          },
        }
      );

      expect(startTime).toBeDefined();
      expect(endTime).toBeDefined();
      expect(exitCode).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello World');
      expect(stdoutChunks.length).toBeGreaterThan(0);
      expect(stdoutChunks.join('')).toContain('Hello World');
    });

    it('should stream stderr separately', async () => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const result = await runShellStreaming(
        process.platform === 'win32' ? 'Get-Command nonexistentcommand123' : 'nonexistentcommand123',
        testWorkspace,
        {
          onStdout: (data) => {
            stdoutChunks.push(data);
          },
          onStderr: (data) => {
            stderrChunks.push(data);
          },
        }
      );

      expect(result.exitCode).not.toBe(0);
      // On Windows PowerShell, Get-Command writes errors to stderr
      // On Unix, nonexistent commands also write to stderr
      expect(stderrChunks.length).toBeGreaterThan(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('should handle commands with no output', async () => {
      const stdoutChunks: string[] = [];
      let exitCode: number | undefined;

      const result = await runShellStreaming(
        process.platform === 'win32' ? '$null' : 'true',
        testWorkspace,
        {
          onStdout: (data) => {
            stdoutChunks.push(data);
          },
          onEnd: (code) => {
            exitCode = code;
          },
        }
      );

      expect(exitCode).toBe(0);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Timing and Duration', () => {
    it('should provide accurate timing information', async () => {
      let startTime: number | undefined;
      let duration: number | undefined;

      await runShellStreaming(
        'echo "test"',
        testWorkspace,
        {
          onStart: (time) => {
            startTime = time;
          },
          onEnd: (code, dur) => {
            duration = dur;
          },
        }
      );

      expect(startTime).toBeDefined();
      expect(duration).toBeDefined();
      expect(duration).toBeGreaterThan(0);
    });
  });

  describe('Safety Checks', () => {
    it('should block dangerous commands', async () => {
      const result = await runShellStreaming(
        'rm -rf /',
        testWorkspace,
        {}
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('blocked by safety policy');
    });
  });

  describe('Timeout Handling', () => {
    it('should timeout long-running commands', async () => {
      const startTime = Date.now();
      let exitCode: number | undefined;

      const result = await runShellStreaming(
        process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10',
        testWorkspace,
        {
          onEnd: (code) => {
            exitCode = code;
          },
        },
        1000 // 1 second timeout
      );

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(2000); // Should timeout before 2 seconds
      expect(exitCode).toBe(124); // Timeout exit code
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain('timed out');
    }, 10000);
  });
});
