import fs from 'fs';
import crypto from 'crypto';
import { logger } from './logger';

/**
 * Result of a file verification operation
 */
export interface VerificationResult {
  success: boolean;
  attempts: number;
  error?: string;
}

/**
 * Options for file verification with retry logic
 */
export interface VerifyOptions {
  maxRetries?: number; // default: 3
  backoffMs?: number; // default: 100
  backoffMultiplier?: number; // default: 2
}

/**
 * File type detection result
 */
export interface FileTypeResult {
  type: 'text' | 'binary' | 'unknown';
  mimeType?: string;
  encoding?: string;
}

/**
 * Size validation options
 */
export interface SizeValidationOptions {
  minSize?: number; // minimum size in bytes
  maxSize?: number; // maximum size in bytes
}

/**
 * Size validation result
 */
export interface SizeValidationResult {
  valid: boolean;
  actualSize: number;
  error?: string;
}

/**
 * Default verification options
 */
const DEFAULT_OPTIONS: Required<VerifyOptions> = {
  maxRetries: 3,
  backoffMs: 100,
  backoffMultiplier: 2,
};

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate SHA-256 hash of a string
 * Used for comparing large file contents efficiently
 */
function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Verify that a file was written correctly by reading it back and comparing content
 * 
 * For small files (<1MB), performs exact string comparison.
 * For large files (>=1MB), compares SHA-256 hashes for efficiency.
 * 
 * @param path - Absolute path to the file to verify
 * @param expectedContent - The content that should have been written
 * @param options - Verification options with retry configuration
 * @returns VerificationResult indicating success, number of attempts, and any error
 */
export async function verifyFileWrite(
  path: string,
  expectedContent: string,
  options?: VerifyOptions
): Promise<VerificationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const useLargeFileMode = expectedContent.length >= 1024 * 1024; // 1MB threshold
  
  let lastError: string | undefined;
  let currentBackoff = opts.backoffMs;

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      logger.debug('Verifying file write', { path, attempt, useLargeFileMode });

      // Check if file exists
      await fs.promises.access(path, fs.constants.F_OK);

      // Read the file content
      const actualContent = await fs.promises.readFile(path, 'utf-8');

      // Compare content (exact match for small files, hash for large files)
      let contentMatches: boolean;
      
      if (useLargeFileMode) {
        const expectedHash = calculateHash(expectedContent);
        const actualHash = calculateHash(actualContent);
        contentMatches = expectedHash === actualHash;
        
        if (!contentMatches) {
          lastError = `Content hash mismatch: expected ${expectedHash}, got ${actualHash}`;
        }
      } else {
        contentMatches = actualContent === expectedContent;
        
        if (!contentMatches) {
          lastError = `Content mismatch: expected ${expectedContent.length} bytes, got ${actualContent.length} bytes`;
        }
      }

      if (contentMatches) {
        logger.info('File write verified successfully', { path, attempt });
        return { success: true, attempts: attempt };
      }

      logger.warn('File write verification failed: content mismatch', { 
        path, 
        attempt,
        error: lastError 
      });

    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn('File write verification failed', { path, attempt, error: lastError });
    }

    // If not the last attempt, wait before retrying
    if (attempt < opts.maxRetries) {
      logger.debug('Retrying file write verification', { path, attempt, delayMs: currentBackoff });
      await sleep(currentBackoff);
      currentBackoff *= opts.backoffMultiplier;
    }
  }

  logger.error('File write verification failed after all retries', { 
    path, 
    attempts: opts.maxRetries,
    error: lastError 
  });

  return {
    success: false,
    attempts: opts.maxRetries,
    error: lastError || 'Unknown verification error',
  };
}

/**
 * Verify that a file exists at the specified path
 * 
 * Uses fs.access() to check file existence without reading content.
 * 
 * @param path - Absolute path to the file to verify
 * @param options - Verification options with retry configuration
 * @returns VerificationResult indicating success, number of attempts, and any error
 */
export async function verifyFileExists(
  path: string,
  options?: VerifyOptions
): Promise<VerificationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: string | undefined;
  let currentBackoff = opts.backoffMs;

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      logger.debug('Verifying file exists', { path, attempt });

      // Check if file exists and is accessible
      await fs.promises.access(path, fs.constants.F_OK);

      logger.info('File existence verified successfully', { path, attempt });
      return { success: true, attempts: attempt };

    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn('File existence verification failed', { path, attempt, error: lastError });
    }

    // If not the last attempt, wait before retrying
    if (attempt < opts.maxRetries) {
      logger.debug('Retrying file existence verification', { path, attempt, delayMs: currentBackoff });
      await sleep(currentBackoff);
      currentBackoff *= opts.backoffMultiplier;
    }
  }

  logger.error('File existence verification failed after all retries', { 
    path, 
    attempts: opts.maxRetries,
    error: lastError 
  });

  return {
    success: false,
    attempts: opts.maxRetries,
    error: lastError || 'File does not exist',
  };
}

/**
 * Verify that a file has been deleted (no longer exists)
 * 
 * Uses fs.access() to confirm file does not exist.
 * Success means the file is NOT accessible (i.e., deleted).
 * 
 * @param path - Absolute path to the file that should be deleted
 * @param options - Verification options with retry configuration
 * @returns VerificationResult indicating success, number of attempts, and any error
 */
export async function verifyFileDeleted(
  path: string,
  options?: VerifyOptions
): Promise<VerificationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: string | undefined;
  let currentBackoff = opts.backoffMs;

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      logger.debug('Verifying file deleted', { path, attempt });

      // Try to access the file - if it succeeds, file still exists (verification failed)
      await fs.promises.access(path, fs.constants.F_OK);

      // If we reach here, file still exists
      lastError = 'File still exists after deletion';
      logger.warn('File deletion verification failed: file still exists', { path, attempt });

    } catch (error) {
      // File does not exist (access failed) - this is what we want!
      const errorCode = (error as NodeJS.ErrnoException).code;
      
      if (errorCode === 'ENOENT') {
        // File not found - deletion verified successfully
        logger.info('File deletion verified successfully', { path, attempt });
        return { success: true, attempts: attempt };
      }

      // Some other error occurred
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn('File deletion verification failed with unexpected error', { 
        path, 
        attempt, 
        error: lastError 
      });
    }

    // If not the last attempt, wait before retrying
    if (attempt < opts.maxRetries) {
      logger.debug('Retrying file deletion verification', { path, attempt, delayMs: currentBackoff });
      await sleep(currentBackoff);
      currentBackoff *= opts.backoffMultiplier;
    }
  }

  logger.error('File deletion verification failed after all retries', { 
    path, 
    attempts: opts.maxRetries,
    error: lastError 
  });

  return {
    success: false,
    attempts: opts.maxRetries,
    error: lastError || 'File deletion could not be verified',
  };
}

/**
 * Detect file type by analyzing file content
 * 
 * Reads the first few bytes of the file to determine if it's text or binary.
 * Also attempts to detect common file types based on magic numbers and extensions.
 * 
 * @param path - Absolute path to the file to analyze
 * @returns FileTypeResult with type classification and optional MIME type
 */
export async function detectFileType(path: string): Promise<FileTypeResult> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    logger.debug('Detecting file type', { path });

    // Reject directories up front — opening + reading a directory throws
    // EISDIR, and if we don't close the handle on that path the FileHandle
    // leaks and Node throws an uncaught "closed during GC" exception.
    const stat = await fs.promises.stat(path);
    if (stat.isDirectory()) {
      return { type: 'unknown' };
    }

    // Read first 512 bytes to check for binary content
    const buffer = Buffer.alloc(512);
    fd = await fs.promises.open(path, 'r');
    const { bytesRead } = await fd.read(buffer, 0, 512, 0);

    // Check for null bytes (strong indicator of binary file)
    const hasNullBytes = buffer.slice(0, bytesRead).includes(0);

    // Check for common binary file magic numbers
    const magicNumbers: Record<string, { bytes: number[]; mimeType: string }> = {
      png: { bytes: [0x89, 0x50, 0x4e, 0x47], mimeType: 'image/png' },
      jpg: { bytes: [0xff, 0xd8, 0xff], mimeType: 'image/jpeg' },
      gif: { bytes: [0x47, 0x49, 0x46], mimeType: 'image/gif' },
      pdf: { bytes: [0x25, 0x50, 0x44, 0x46], mimeType: 'application/pdf' },
      zip: { bytes: [0x50, 0x4b, 0x03, 0x04], mimeType: 'application/zip' },
    };

    // Check for magic numbers
    for (const [type, { bytes, mimeType }] of Object.entries(magicNumbers)) {
      if (bytesRead >= bytes.length) {
        const matches = bytes.every((byte, index) => buffer[index] === byte);
        if (matches) {
          logger.info('File type detected via magic number', { path, type, mimeType });
          return { type: 'binary', mimeType };
        }
      }
    }

    // If has null bytes, it's likely binary
    if (hasNullBytes) {
      logger.info('File type detected as binary (null bytes found)', { path });
      return { type: 'binary' };
    }

    // Check if content is valid UTF-8 text
    const content = buffer.slice(0, bytesRead).toString('utf-8');
    const isValidUtf8 = !content.includes('\ufffd'); // Replacement character indicates invalid UTF-8

    if (isValidUtf8) {
      logger.info('File type detected as text', { path, encoding: 'utf-8' });
      return { type: 'text', encoding: 'utf-8' };
    }

    // Unable to determine definitively
    logger.info('File type unknown', { path });
    return { type: 'unknown' };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('File type detection failed', { path, error: errorMsg });
    return { type: 'unknown' };
  } finally {
    // ALWAYS close the handle — even when read() throws (e.g. EISDIR). Leaving
    // it open caused Node to throw an uncaught "FileHandle closed during
    // garbage collection" exception.
    if (fd) {
      try { await fd.close(); } catch { /* already closed / nothing to do */ }
    }
  }
}

/**
 * Validate file size against specified constraints
 * 
 * Checks if a file's size falls within the specified minimum and maximum bounds.
 * 
 * @param path - Absolute path to the file to validate
 * @param options - Size validation options with min/max size constraints
 * @returns SizeValidationResult indicating validity, actual size, and any error
 */
export async function validateFileSize(
  path: string,
  options: SizeValidationOptions
): Promise<SizeValidationResult> {
  try {
    logger.debug('Validating file size', { path, options });

    // Get file stats
    const stats = await fs.promises.stat(path);
    const actualSize = stats.size;

    // Check minimum size
    if (options.minSize !== undefined && actualSize < options.minSize) {
      const error = `File size ${actualSize} bytes is below minimum ${options.minSize} bytes`;
      logger.warn('File size validation failed: too small', { path, actualSize, minSize: options.minSize });
      return { valid: false, actualSize, error };
    }

    // Check maximum size
    if (options.maxSize !== undefined && actualSize > options.maxSize) {
      const error = `File size ${actualSize} bytes exceeds maximum ${options.maxSize} bytes`;
      logger.warn('File size validation failed: too large', { path, actualSize, maxSize: options.maxSize });
      return { valid: false, actualSize, error };
    }

    logger.info('File size validation passed', { path, actualSize });
    return { valid: true, actualSize };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('File size validation failed', { path, error: errorMsg });
    return { 
      valid: false, 
      actualSize: 0, 
      error: `Failed to validate file size: ${errorMsg}` 
    };
  }
}
