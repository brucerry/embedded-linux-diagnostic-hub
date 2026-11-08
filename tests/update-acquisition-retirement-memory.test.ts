import { loadMemoryCases } from './fixtures/memory-case-loader';

loadMemoryCases(
    new URL('./update-acquisition-retirement-memory.cases.ts', import.meta.url),
    'owned-fs',
);
