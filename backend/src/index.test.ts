import { logger } from './utils/logger';

describe('Backend Startup', () => {
  it('should log platform and shell configuration', () => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : 'sh';
    
    // Verify platform detection
    expect(process.platform).toBeDefined();
    expect(shell).toBeDefined();
    
    // Log the configuration (this would happen at startup)
    logger.info('Platform configuration test', {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      shell,
      isWindows
    });
    
    // Verify the values are correct
    if (process.platform === 'win32') {
      expect(shell).toBe('powershell.exe');
      expect(isWindows).toBe(true);
    } else {
      expect(shell).toBe('sh');
      expect(isWindows).toBe(false);
    }
  });
});
