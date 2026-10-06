/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Charge les variables d'environnement de test AVANT tout import de module
  setupFiles: ['<rootDir>/tests/setup.ts'],
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  // Évite les appels réseau réels pendant les tests
  clearMocks: true,
  maxWorkers: 1,
  detectOpenHandles: true,
};