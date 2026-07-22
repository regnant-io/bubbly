# File Verifier Utility

## Overview

The File Verifier utility provides robust file operation verification with automatic retry logic and exponential backoff. It ensures file operations (write, create, delete) succeed and prevents silent failures.

## Features

- **Write Verification**: Read file back and compare content (exact match for small files, SHA-256 hash for large files >1MB)
- **Existence Verification**: Check if a file exists using `fs.access()`
- **Deletion Verification**: Verify a file no longer exists after deletion
- **Exponential Backoff**: Automatic retry with configurable backoff (default: 100ms, 200ms, 400ms)
- **Detailed Logging**: All verification attempts and results are logged
- **Error Reporting**: Detailed error messages for debugging

## API Reference

### `verifyFileWrite(path, expectedContent, options?)`

Verifies that a file was written correctly by reading it back and comparing content.

**Parameters:**
- `path` (string): Absolute path to the file to verify
- `expectedContent` (string): The content that should have been written
- `options` (VerifyOptions, optional): Verification options
  - `maxRetries` (number, default: 3): Maximum number of retry attempts
  - `backoffMs` (number, default: 100): Initial backoff delay in milliseconds
  - `backoffMultiplier` (number, default: 2): Backoff multiplier for exponential backoff

**Returns:** `Promise<VerificationResult>`
- `success` (boolean): Whether verification succeeded
- `attempts` (number): Number of attempts made
- `error` (string, optional): Error message if verification failed

**Example:**
```typescript
import { verifyFileWrite } from './utils/fileVerifier';

const result = await verifyFileWrite('/path/to/file.txt', 'Hello, World!');
if (result.success) {
  console.log(`File verified in ${result.attempts} attempt(s)`);
} else {
  console.error(`Verification failed: ${result.error}`);
}
```

### `verifyFileExists(path, options?)`

Verifies that a file exists at the specified path.

**Parameters:**
- `path` (string): Absolute path to the file to verify
- `options` (VerifyOptions, optional): Verification options

**Returns:** `Promise<VerificationResult>`

**Example:**
```typescript
import { verifyFileExists } from './utils/fileVerifier';

const result = await verifyFileExists('/path/to/file.txt');
if (result.success) {
  console.log('File exists');
} else {
  console.error(`File does not exist: ${result.error}`);
}
```

### `verifyFileDeleted(path, options?)`

Verifies that a file has been deleted (no longer exists).

**Parameters:**
- `path` (string): Absolute path to the file that should be deleted
- `options` (VerifyOptions, optional): Verification options

**Returns:** `Promise<VerificationResult>`

**Example:**
```typescript
import { verifyFileDeleted } from './utils/fileVerifier';

const result = await verifyFileDeleted('/path/to/file.txt');
if (result.success) {
  console.log('File successfully deleted');
} else {
  console.error(`File still exists: ${result.error}`);
}
```

## Integration with Filesystem Tools

The File Verifier is designed to be integrated into the filesystem tools in `backend/src/agent/tools/filesystem.ts`. Here's an example integration:

```typescript
import { verifyFileWrite, verifyFileExists, verifyFileDeleted } from '../../utils/fileVerifier';

export async function writeFile(
  workspacePath: string,
  filePath: string,
  content: string
): Promise<{ success: boolean; diff: FileDiff }> {
  const fullPath = resolveSafePath(workspacePath, filePath);
  const dir = path.dirname(fullPath);
  
  // Create directory if needed
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  const existed = fs.existsSync(fullPath);
  const oldContent = existed ? fs.readFileSync(fullPath, 'utf8') : '';
  fs.writeFileSync(fullPath, content, 'utf8');

  // Verify write succeeded
  const verification = await verifyFileWrite(fullPath, content);
  
  if (!verification.success) {
    logger.error('File write verification failed', { 
      path: filePath, 
      attempts: verification.attempts,
      error: verification.error 
    });
    throw new Error(`File write failed verification: ${verification.error}`);
  }
  
  logger.info('File write verified', { path: filePath, attempts: verification.attempts });

  // Generate diff and return result
  const patch = existed
    ? createPatch(filePath, oldContent, content, 'before', 'after')
    : createPatch(filePath, '', content, 'before', 'after');

  return {
    success: true,
    diff: {
      path: filePath,
      type: existed ? 'modified' : 'created',
      diff: patch,
      additions: (patch.match(/^\+[^+]/gm) ?? []).length,
      deletions: (patch.match(/^-[^-]/gm) ?? []).length,
    },
  };
}
```

## Performance Considerations

### Small Files (<1MB)
- Uses exact string comparison
- Fast and reliable for most use cases

### Large Files (≥1MB)
- Uses SHA-256 hash comparison
- Avoids memory issues with very large files
- Slightly slower but more memory-efficient

### Retry Logic
- Default: 3 attempts with 100ms, 200ms, 400ms delays
- Total maximum delay: ~700ms for default configuration
- Configurable for different use cases

## Error Handling

The File Verifier provides detailed error messages for debugging:

- **Content Mismatch**: "Content mismatch: expected X bytes, got Y bytes"
- **Hash Mismatch**: "Content hash mismatch: expected [hash], got [hash]"
- **File Not Found**: "ENOENT: no such file or directory, access '[path]'"
- **File Still Exists**: "File still exists after deletion"

All errors are logged with context (path, attempt number, error details) for easy troubleshooting.

## Testing

### Manual Testing

Run the manual test script:
```bash
npx ts-node src/utils/fileVerifier.manual-test.ts
```

### Unit Testing

The utility includes comprehensive unit tests in `fileVerifier.test.ts`. Run with your test runner:
```bash
npm test
```

## Requirements Satisfied

This utility satisfies the following requirements from the specification:

- **2.1**: Write verification with content comparison
- **2.2**: File existence verification using fs.access()
- **2.3**: File deletion verification
- **2.4**: Detailed error reporting on verification failure
- **2.5**: Retry logic with exponential backoff (up to 3 times)
- **2.6**: Logging of all verification attempts and results
- **2.7**: Verification confirmation in tool results

## Future Enhancements

Potential improvements for future versions:

1. **Parallel Verification**: Verify multiple files concurrently
2. **Checksum Caching**: Cache file checksums to avoid re-reading
3. **Custom Comparison**: Allow custom comparison functions
4. **Metrics Collection**: Track verification success rates and timing
5. **Configurable Hash Algorithm**: Support different hash algorithms (MD5, SHA-1, etc.)
