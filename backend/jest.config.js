module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Point every test file at its own temp sqlite db (never the user's real one).
  setupFiles: ['<rootDir>/jest.setup.js'],
  globalTeardown: '<rootDir>/jest.teardown.js',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  /*
   * HALF THE CORES, NOT ALL OF THEM.
   *
   * A large part of this suite spawns REAL processes — shells, PTYs, node
   * subprocesses — because the things most worth testing here (Windows
   * quoting, exit-code propagation, terminal idle detection) cannot be tested
   * against a mock without testing the mock. Those tests are inherently
   * timing-sensitive, and Jest's default of one worker per core means the
   * machine is running one shell per core WHILE trying to measure how long a
   * shell takes to go quiet. The result is a suite that fails somewhere
   * different on every run and passes on every one of those tests in isolation
   * — which reads as flakiness in the code rather than in the harness.
   *
   * Halving the workers leaves headroom for the processes the tests spawn. The
   * suite is CPU-light and process-heavy, so this costs very little wall time.
   */
  maxWorkers: '50%',
  /*
   * A leaked PTY handle must not hang CI.
   *
   * node-pty's helper processes do not always release the event loop on
   * Windows, so Jest can finish every test and then sit forever waiting to
   * exit. Every test tears its own terminals down; this is the backstop for
   * the handle we cannot reach from JavaScript.
   */
  forceExit: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.d.ts',
  ],
};
