import { loadMemoryCases } from './fixtures/memory-case-loader';

loadMemoryCases(new URL('./desktop-connection-retirement.cases.ts', import.meta.url), 'ssh');
