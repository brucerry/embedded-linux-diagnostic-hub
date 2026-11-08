import { loadMemoryCases } from './fixtures/memory-case-loader';

loadMemoryCases(new URL('./updater-cache-failure-memory.cases.ts', import.meta.url), 'updater-fs');
