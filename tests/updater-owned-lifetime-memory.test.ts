import { loadMemoryCases } from './fixtures/memory-case-loader';

loadMemoryCases(new URL('./updater-owned-lifetime-memory.cases.ts', import.meta.url), 'owned-fs');
