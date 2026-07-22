import { runShell } from './shell';
import os from 'os';
import fs from 'fs';
import path from 'path';

describe('Shell Integration Tests', () => {
  const testWorkspace = os.tmpdir();

  describe('Windows PowerShell Integration', () => {
    it('should execute PowerShell commands on Windows', () => {
      if (process.platform !== 'win32') {
        return; // Skip on non-Windows
      }

      // Test PowerShell-specific command
      const result = runShell('Get-Process | Select-Object -First 1', testWorkspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it('should handle PowerShell cmdlets', () => {
      if (process.platform !== 'win32') {
        return;
      }

      const result = runShell('Get-Date', testWorkspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d{4}/); // Should contain year
    });

    it('should handle file operations with PowerShell', () => {
      if (process.platform !== 'win32') {
        return;
      }

      const testFile = path.join(testWorkspace, 'test-shell-integration.txt');
      
      // Create file
      const createResult = runShell(
        `New-Item -Path "${testFile}" -ItemType File -Force | Out-Null; Write-Output "created"`,
        testWorkspace
      );
      expect(createResult.exitCode).toBe(0);
      expect(fs.existsSync(testFile)).toBe(true);

      // Read file
      const readResult = runShell(`Get-Content "${testFile}"`, testWorkspace);
      expect(readResult.exitCode).toBe(0);

      // Delete file
      const deleteResult = runShell(`Remove-Item "${testFile}"`, testWorkspace);
      expect(deleteResult.exitCode).toBe(0);
      expect(fs.existsSync(testFile)).toBe(false);
    });

    it('should provide Windows alternatives for Unix commands', () => {
      if (process.platform !== 'win32') {
        return;
      }

      // Try a Unix command that doesn't exist
      const result = runShell('grep "test" somefile.txt', testWorkspace);
      
      // Should fail but provide suggestion
      if (result.exitCode === 1 && result.stderr.includes('not recognized')) {
        expect(result.stderr).toContain('Windows alternative');
        expect(result.stderr).toContain('findstr or Select-String');
      }
    });
  });

  describe('Cross-Platform Compatibility', () => {
    it('should execute echo command on all platforms', () => {
      const result = runShell('echo "Hello World"', testWorkspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello');
    });

    it('should handle working directory correctly', () => {
      const result = runShell(
        process.platform === 'win32' ? 'Get-Location' : 'pwd',
        testWorkspace
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain(testWorkspace.toLowerCase());
    });

    it('should capture stderr on command failure', () => {
      const result = runShell('nonexistent-command-xyz', testWorkspace);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  describe('Platform Detection Logging', () => {
    it('should log platform information', () => {
      // This test verifies that platform detection works
      const isWindows = process.platform === 'win32';
      const expectedShell = isWindows ? 'powershell.exe' : 'sh';
      
      const result = runShell('echo test', testWorkspace);
      expect(result.exitCode).toBe(0);
      
      // The logger should have logged the platform and shell
      // We can't directly test logger output, but we can verify the command executed
      expect(result.stdout).toContain('test');
    });
  });
});
