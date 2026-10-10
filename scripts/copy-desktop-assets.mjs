import { copyFile, readFile, writeFile } from 'node:fs/promises';

await copyFile(
    new URL('../electron/taskbar-query.ps1', import.meta.url),
    new URL('../dist-electron/taskbar-query.ps1', import.meta.url),
);
const html = (await readFile(new URL('../genie.html', import.meta.url), 'utf8'))
    .replace('src="/electron/genie-renderer.ts"', 'src="./genie-renderer.js"')
    .replace('</head>', '<link rel="stylesheet" href="./genie-renderer.css" /></head>');
await writeFile(new URL('../dist/genie.html', import.meta.url), html);
