import { spawnSync } from 'node:child_process';

const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build:web', '--', '--outDir', 'dist-site'],
    {
        stdio: 'inherit',
        env: { ...process.env, WEB_BASE_PATH: './' },
        shell: process.platform === 'win32',
    },
);
if (result.status !== 0) process.exit(result.status ?? 1);
