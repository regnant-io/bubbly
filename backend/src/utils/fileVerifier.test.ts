import fs from 'fs';
import path from 'path';
import os from 'os';
import { 
  verifyFileWrite, 
  verifyFileExists, 
  verifyFileDeleted,
  detectFileType,
  validateFileSize 
} from './fileVerifier';

describe('File Verifier', () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bubbly-test-'));
    testFilePath = path.join(testDir, 'test-file.txt');
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('verifyFileWrite', () => {
    it('should verify a successfully written file', async () => {
      const content = 'Hello, World!';
      await fs.promises.writeFile(testFilePath, content, 'utf-8');

      const result = await verifyFileWrite(testFilePath, content);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should detect content mismatch', async () => {
      const writtenContent = 'Hello, World!';
      const expectedContent = 'Goodbye, World!';
      await fs.promises.writeFile(testFilePath, writtenContent, 'utf-8');

      const result = await verifyFileWrite(testFilePath, expectedContent, { maxRetries: 2 });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.error).toContain('mismatch');
    });

    it('should handle missing file', async () => {
      const result = await verifyFileWrite(testFilePath, 'content', { maxRetries: 2 });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.error).toBeDefined();
    });

    it('should verify large files using hash comparison', async () => {
      // Create a file larger than 1MB
      const largeContent = 'x'.repeat(1024 * 1024 + 100);
      await fs.promises.writeFile(testFilePath, largeContent, 'utf-8');

      const result = await verifyFileWrite(testFilePath, largeContent);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it('should use exponential backoff on retries', async () => {
      const startTime = Date.now();
      
      // File doesn't exist, so it will retry
      const result = await verifyFileWrite(testFilePath, 'content', {
        maxRetries: 3,
        backoffMs: 50,
        backoffMultiplier: 2,
      });

      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      // Should have waited: 50ms + 100ms = 150ms minimum
      expect(elapsed).toBeGreaterThanOrEqual(150);
    });
  });

  describe('verifyFileExists', () => {
    it('should verify an existing file', async () => {
      await fs.promises.writeFile(testFilePath, 'content', 'utf-8');

      const result = await verifyFileExists(testFilePath);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should fail for non-existent file', async () => {
      const result = await verifyFileExists(testFilePath, { maxRetries: 2 });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.error).toBeDefined();
    });

    it('should retry and succeed if file appears', async () => {
      // Start verification in background
      const verifyPromise = verifyFileExists(testFilePath, {
        maxRetries: 3,
        backoffMs: 50,
      });

      // Create file after a short delay
      setTimeout(async () => {
        await fs.promises.writeFile(testFilePath, 'content', 'utf-8');
      }, 75);

      const result = await verifyPromise;

      expect(result.success).toBe(true);
      expect(result.attempts).toBeGreaterThan(1);
    });
  });

  describe('verifyFileDeleted', () => {
    it('should verify a deleted file', async () => {
      // Create and then delete file
      await fs.promises.writeFile(testFilePath, 'content', 'utf-8');
      await fs.promises.unlink(testFilePath);

      const result = await verifyFileDeleted(testFilePath);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('should fail if file still exists', async () => {
      await fs.promises.writeFile(testFilePath, 'content', 'utf-8');

      const result = await verifyFileDeleted(testFilePath, { maxRetries: 2 });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.error).toContain('still exists');
    });

    it('should retry and succeed if file is deleted', async () => {
      await fs.promises.writeFile(testFilePath, 'content', 'utf-8');

      // Start verification in background
      const verifyPromise = verifyFileDeleted(testFilePath, {
        maxRetries: 3,
        backoffMs: 50,
      });

      // Delete file after a short delay
      setTimeout(async () => {
        await fs.promises.unlink(testFilePath);
      }, 75);

      const result = await verifyPromise;

      expect(result.success).toBe(true);
      expect(result.attempts).toBeGreaterThan(1);
    });
  });

  describe('retry configuration', () => {
    it('should respect custom maxRetries', async () => {
      const result = await verifyFileExists(testFilePath, { maxRetries: 5 });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(5);
    });

    it('should respect custom backoff settings', async () => {
      const startTime = Date.now();

      const result = await verifyFileExists(testFilePath, {
        maxRetries: 2,
        backoffMs: 100,
        backoffMultiplier: 3,
      });

      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      // Should have waited: 100ms minimum
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });
  });

  describe('detectFileType', () => {
    it('should detect text files', async () => {
      const textContent = 'Hello, World!\nThis is a text file.';
      await fs.promises.writeFile(testFilePath, textContent, 'utf-8');

      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('text');
      expect(result.encoding).toBe('utf-8');
    });

    it('should detect binary files with null bytes', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff]);
      await fs.promises.writeFile(testFilePath, binaryContent);

      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('binary');
    });

    it('should detect PNG files by magic number', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.promises.writeFile(testFilePath, pngHeader);

      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('binary');
      expect(result.mimeType).toBe('image/png');
    });

    it('should detect JPEG files by magic number', async () => {
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      await fs.promises.writeFile(testFilePath, jpegHeader);

      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('binary');
      expect(result.mimeType).toBe('image/jpeg');
    });

    it('should detect PDF files by magic number', async () => {
      const pdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
      await fs.promises.writeFile(testFilePath, pdfHeader);

      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('binary');
      expect(result.mimeType).toBe('application/pdf');
    });

    it('should detect ZIP files by magic number', async () => {
      const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
      await fs.promises.writeFile(testFilePath, zipHeader);

      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('binary');
      expect(result.mimeType).toBe('application/zip');
    });

    it('should handle non-existent files gracefully', async () => {
      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('unknown');
    });

    it('should handle empty files', async () => {
      await fs.promises.writeFile(testFilePath, '');

      const result = await detectFileType(testFilePath);

      expect(result.type).toBe('text');
    });
  });

  describe('validateFileSize', () => {
    it('should validate file within size limits', async () => {
      const content = 'x'.repeat(500);
      await fs.promises.writeFile(testFilePath, content, 'utf-8');

      const result = await validateFileSize(testFilePath, {
        minSize: 100,
        maxSize: 1000,
      });

      expect(result.valid).toBe(true);
      expect(result.actualSize).toBe(500);
      expect(result.error).toBeUndefined();
    });

    it('should reject file below minimum size', async () => {
      const content = 'small';
      await fs.promises.writeFile(testFilePath, content, 'utf-8');

      const result = await validateFileSize(testFilePath, {
        minSize: 100,
      });

      expect(result.valid).toBe(false);
      expect(result.actualSize).toBe(5);
      expect(result.error).toContain('below minimum');
    });

    it('should reject file above maximum size', async () => {
      const content = 'x'.repeat(2000);
      await fs.promises.writeFile(testFilePath, content, 'utf-8');

      const result = await validateFileSize(testFilePath, {
        maxSize: 1000,
      });

      expect(result.valid).toBe(false);
      expect(result.actualSize).toBe(2000);
      expect(result.error).toContain('exceeds maximum');
    });

    it('should validate with only minimum size', async () => {
      const content = 'x'.repeat(500);
      await fs.promises.writeFile(testFilePath, content, 'utf-8');

      const result = await validateFileSize(testFilePath, {
        minSize: 100,
      });

      expect(result.valid).toBe(true);
      expect(result.actualSize).toBe(500);
    });

    it('should validate with only maximum size', async () => {
      const content = 'x'.repeat(500);
      await fs.promises.writeFile(testFilePath, content, 'utf-8');

      const result = await validateFileSize(testFilePath, {
        maxSize: 1000,
      });

      expect(result.valid).toBe(true);
      expect(result.actualSize).toBe(500);
    });

    it('should handle non-existent files', async () => {
      const result = await validateFileSize(testFilePath, {
        minSize: 100,
        maxSize: 1000,
      });

      expect(result.valid).toBe(false);
      expect(result.actualSize).toBe(0);
      expect(result.error).toContain('Failed to validate');
    });

    it('should validate zero-byte files', async () => {
      await fs.promises.writeFile(testFilePath, '');

      const result = await validateFileSize(testFilePath, {
        minSize: 0,
        maxSize: 100,
      });

      expect(result.valid).toBe(true);
      expect(result.actualSize).toBe(0);
    });

    it('should handle exact size boundaries', async () => {
      const content = 'x'.repeat(1000);
      await fs.promises.writeFile(testFilePath, content, 'utf-8');

      // Test exact minimum
      const minResult = await validateFileSize(testFilePath, {
        minSize: 1000,
      });
      expect(minResult.valid).toBe(true);

      // Test exact maximum
      const maxResult = await validateFileSize(testFilePath, {
        maxSize: 1000,
      });
      expect(maxResult.valid).toBe(true);
    });
  });
});
