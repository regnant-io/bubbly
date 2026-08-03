import fs from 'fs';
import path from 'path';
import os from 'os';
import { readFile, writeFile, deleteFile } from './filesystem';

describe('Filesystem Tools Integration', () => {
  let testDir: string;
  let workspacePath: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbly-fs-integration-'));
    workspacePath = testDir;
    // Keep the external project-data store inside the temp dir so redirects are
    // exercised without touching the real ~/.bubbly.
    process.env.BUBBLY_PROJECTS_ROOT = path.join(testDir, '__store');
  });

  afterEach(() => {
    delete process.env.BUBBLY_PROJECTS_ROOT;
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('.bubbly redirect (external project data)', () => {
    it('writes .bubbly/* OUTSIDE the workspace, and reads it back at the same virtual path', async () => {
      await writeFile(workspacePath, '.bubbly/checkpoints/c1/note.md', '# Reqs');
      // The virtual path round-trips for the agent…
      expect(await readFile(workspacePath, '.bubbly/checkpoints/c1/note.md')).toBe('# Reqs');
      // …but nothing landed inside the project, so a clean-slate scaffold is safe.
      expect(fs.existsSync(path.join(workspacePath, '.bubbly'))).toBe(false);
      // Only the file the test created is in the workspace (no .bubbly).
      expect(fs.readdirSync(workspacePath).filter((n) => n !== '__store')).toEqual([]);
    });

    it('routes an absolute in-project .bubbly path to the same external place', async () => {
      await writeFile(workspacePath, '.bubbly/note.txt', 'via-relative');
      const abs = path.join(workspacePath, '.bubbly', 'note.txt');
      // Addressing the same thing by absolute path reads the redirected file.
      expect(await readFile(workspacePath, abs)).toBe('via-relative');
    });
  });

  describe('File Type Detection', () => {
    it('rejects reading a directory with a clear error (no FileHandle leak)', async () => {
      // Regression: read_file on a directory previously leaked a FileHandle
      // (EISDIR inside detectFileType) and reported a misleading "size 0" read,
      // crashing the process with an uncaught "closed during GC" exception.
      fs.mkdirSync(path.join(workspacePath, 'a-dir'));
      await expect(readFile(workspacePath, 'a-dir')).rejects.toThrow(/is a directory/i);
    });

    it('should read text files successfully', async () => {
      const testFile = 'test.txt';
      const testContent = 'Hello, World!';
      
      // Write file directly
      fs.writeFileSync(path.join(workspacePath, testFile), testContent);
      
      // Read using our function
      const content = await readFile(workspacePath, testFile);
      expect(content).toBe(testContent);
    });

    it('should reject binary files', async () => {
      const testFile = 'test.bin';
      
      // Write binary file with null bytes
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      fs.writeFileSync(path.join(workspacePath, testFile), binaryContent);
      
      // Attempt to read should throw
      await expect(readFile(workspacePath, testFile)).rejects.toThrow(
        /Cannot read binary file as text/
      );
    });

    it('should detect PNG files', async () => {
      const testFile = 'test.png';
      
      // Write PNG magic number
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(path.join(workspacePath, testFile), pngHeader);
      
      // Attempt to read should throw with PNG detection
      await expect(readFile(workspacePath, testFile)).rejects.toThrow(
        /detected as image\/png/
      );
    });
  });

  describe('Size Validation', () => {
    it('should warn about large files', async () => {
      const testFile = 'large.txt';
      const largeContent = 'x'.repeat(600_000); // 600KB
      
      // Write large file directly
      fs.writeFileSync(path.join(workspacePath, testFile), largeContent);
      
      // Read should truncate and clearly mark the result as a partial view.
      const content = await readFile(workspacePath, testFile);
      expect(content).toContain('PARTIAL FILE VIEW');
      expect(content).toContain('Do NOT write this content back');
    });

    it('should handle normal-sized files', async () => {
      const testFile = 'normal.txt';
      const normalContent = 'This is a normal file';
      
      // Write normal file directly
      fs.writeFileSync(path.join(workspacePath, testFile), normalContent);
      
      // Read should return full content
      const content = await readFile(workspacePath, testFile);
      expect(content).toBe(normalContent);
    });
  });

  describe('Write Verification', () => {
    it('should verify write operations', async () => {
      const testFile = 'verified.txt';
      const testContent = 'This content should be verified';
      
      // Write using our function
      const result = await writeFile(workspacePath, testFile, testContent);
      
      expect(result.success).toBe(true);
      expect(result.diff.type).toBe('created');
      
      // Verify file actually exists and has correct content
      const actualContent = fs.readFileSync(path.join(workspacePath, testFile), 'utf-8');
      expect(actualContent).toBe(testContent);
    });

    it('should detect write failures', async () => {
      const testFile = 'readonly/test.txt';
      const testContent = 'This should fail';
      
      // Create readonly directory
      const readonlyDir = path.join(workspacePath, 'readonly');
      fs.mkdirSync(readonlyDir);
      
      // Write a file first
      const filePath = path.join(readonlyDir, 'test.txt');
      fs.writeFileSync(filePath, 'initial');
      
      // Make directory readonly (Windows: remove write permissions)
      if (process.platform === 'win32') {
        // On Windows, we can't easily make a directory readonly in the same way
        // Skip this test on Windows
        return;
      }
      
      fs.chmodSync(readonlyDir, 0o444);
      
      // Attempt to write should fail
      await expect(writeFile(workspacePath, testFile, testContent)).rejects.toThrow();
      
      // Restore permissions for cleanup
      fs.chmodSync(readonlyDir, 0o755);
    });
  });

  describe('Delete Verification', () => {
    it('should verify delete operations', async () => {
      const testFile = 'to-delete.txt';
      
      // Create file
      fs.writeFileSync(path.join(workspacePath, testFile), 'Delete me');
      
      // Delete using our function
      const result = await deleteFile(workspacePath, testFile);
      
      expect(result.success).toBe(true);
      
      // Verify file is actually gone
      expect(fs.existsSync(path.join(workspacePath, testFile))).toBe(false);
    });

    it('should fail for non-existent files', async () => {
      const testFile = 'does-not-exist.txt';
      
      // Attempt to delete non-existent file should throw
      await expect(deleteFile(workspacePath, testFile)).rejects.toThrow(
        /File not found/
      );
    });
  });

  describe('End-to-End Workflow', () => {
    it('should handle complete file lifecycle', async () => {
      const testFile = 'lifecycle.txt';
      const content1 = 'Initial content';
      const content2 = 'Updated content';
      
      // 1. Write file
      const writeResult1 = await writeFile(workspacePath, testFile, content1);
      expect(writeResult1.success).toBe(true);
      expect(writeResult1.diff.type).toBe('created');
      
      // 2. Read file
      const readContent1 = await readFile(workspacePath, testFile);
      expect(readContent1).toBe(content1);
      
      // 3. Update file
      const writeResult2 = await writeFile(workspacePath, testFile, content2);
      expect(writeResult2.success).toBe(true);
      expect(writeResult2.diff.type).toBe('modified');
      
      // 4. Read updated file
      const readContent2 = await readFile(workspacePath, testFile);
      expect(readContent2).toBe(content2);
      
      // 5. Delete file
      const deleteResult = await deleteFile(workspacePath, testFile);
      expect(deleteResult.success).toBe(true);
      
      // 6. Verify file is gone
      await expect(readFile(workspacePath, testFile)).rejects.toThrow(
        /File not found/
      );
    });
  });
});
