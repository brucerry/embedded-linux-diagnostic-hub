import { loadMemoryCases } from './fixtures/memory-case-loader';

loadMemoryCases(new URL('./updater-owned-marker-memory.cases.ts', import.meta.url), 'owned-fs');
