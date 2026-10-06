import { cp, mkdir } from 'node:fs/promises';
import { LAUNCHERS } from './lib/release-assets.mjs';

await mkdir('release', { recursive: true });
for (const launcher of LAUNCHERS) await cp(`public/${launcher}`, `release/${launcher}`);
console.log('Release download-and-run launchers copied.');
