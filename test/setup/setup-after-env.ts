import { truncateAll } from './db';

jest.setTimeout(30_000);

// Spec files run one at a time (maxWorkers: 1) and each starts on empty
// tables, so no spec depends on data another one left behind.
beforeAll(truncateAll);
