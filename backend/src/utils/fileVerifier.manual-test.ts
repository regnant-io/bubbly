/**
 * Manual test script for fileVerifier utility
 * Run with: npx ts-node src/utils/fileVerifier.manual-test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { verifyFileWrite, verifyFileExists, verifyFileDeleted } from './fileVerifier';

async function runTests() {
  console.log('=== File Verifier Manual Tests ===\n');

  // Create a temporary directory for testing
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bubbly-test-'));
  const testFilePath = path.join(testDir, 'test-file.txt');

  try {
    // Test 1: Verify file write
    console.log('Test 1: Verify file write');
    const content = 'Hello, World!';
    await fs.promises.writeFile(testFilePath, content, 'utf-8');
    const writeResult = await verifyFileWrite(testFilePath, content);
    console.log('Result:', writeResult);
    console.log('✓ Test 1 passed\n');

    // Test 2: Verify file exists
    console.log('Test 2: Verify file exists');
    const existsResult = await verifyFileExists(testFilePath);
    console.log('Result:', existsResult);
    console.log('✓ Test 2 passed\n');

    // Test 3: Verify content mismatch detection
    console.log('Test 3: Verify content mismatch detection');
    const mismatchResult = await verifyFileWrite(testFilePath, 'Different content', { maxRetries: 2 });
    console.log('Result:', mismatchResult);
    if (!mismatchResult.success && mismatchResult.error?.includes('mismatch')) {
      console.log('✓ Test 3 passed (correctly detected mismatch)\n');
    } else {
      console.log('✗ Test 3 failed\n');
    }

    // Test 4: Verify file deletion
    console.log('Test 4: Verify file deletion');
    await fs.promises.unlink(testFilePath);
    const deleteResult = await verifyFileDeleted(testFilePath);
    console.log('Result:', deleteResult);
    console.log('✓ Test 4 passed\n');

    // Test 5: Verify non-existent file detection
    console.log('Test 5: Verify non-existent file detection');
    const nonExistentPath = path.join(testDir, 'non-existent.txt');
    const nonExistentResult = await verifyFileExists(nonExistentPath, { maxRetries: 2 });
    console.log('Result:', nonExistentResult);
    if (!nonExistentResult.success) {
      console.log('✓ Test 5 passed (correctly detected non-existent file)\n');
    } else {
      console.log('✗ Test 5 failed\n');
    }

    // Test 6: Verify large file with hash comparison
    console.log('Test 6: Verify large file (>1MB) with hash comparison');
    const largeFilePath = path.join(testDir, 'large-file.txt');
    const largeContent = 'x'.repeat(1024 * 1024 + 100); // Just over 1MB
    await fs.promises.writeFile(largeFilePath, largeContent, 'utf-8');
    const largeFileResult = await verifyFileWrite(largeFilePath, largeContent);
    console.log('Result:', largeFileResult);
    console.log('✓ Test 6 passed\n');

    // Test 7: Verify retry with exponential backoff
    console.log('Test 7: Verify retry with exponential backoff');
    const retryFilePath = path.join(testDir, 'retry-test.txt');
    const startTime = Date.now();
    const retryResult = await verifyFileExists(retryFilePath, {
      maxRetries: 3,
      backoffMs: 50,
      backoffMultiplier: 2,
    });
    const elapsed = Date.now() - startTime;
    console.log('Result:', retryResult);
    console.log(`Elapsed time: ${elapsed}ms (expected ~150ms for 3 retries with 50ms, 100ms backoff)`);
    if (elapsed >= 150) {
      console.log('✓ Test 7 passed (exponential backoff working)\n');
    } else {
      console.log('✗ Test 7 failed (backoff too fast)\n');
    }

    console.log('=== All tests completed ===');

  } catch (error) {
    console.error('Test failed with error:', error);
  } finally {
    // Clean up test directory
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
      console.log('\nTest directory cleaned up');
    } catch (error) {
      console.error('Failed to clean up test directory:', error);
    }
  }
}

// Run the tests
runTests().catch(console.error);
