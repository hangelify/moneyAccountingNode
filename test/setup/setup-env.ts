import { applyTestEnv } from './test-env';

// Runs before each spec file is imported: AppModule and the modules it pulls
// in see the test env from their first line.
applyTestEnv();
