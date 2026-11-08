import { loadMemoryCases } from './fixtures/memory-case-loader';

loadMemoryCases(new URL('./desktop-console-retirement-memory.cases.ts', import.meta.url), 'ssh');
