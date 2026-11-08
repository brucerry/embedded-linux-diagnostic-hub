import { loadMemoryCases } from './fixtures/memory-case-loader';

loadMemoryCases(new URL('./updater-coordinator-memory.cases.ts', import.meta.url), 'updater-fs');
