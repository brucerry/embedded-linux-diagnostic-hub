import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const vswhere = path.join(
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        'Microsoft Visual Studio/Installer/vswhere.exe',
    );
    const installation = execFileSync(
        vswhere,
        [
            '-latest',
            '-products',
            '*',
            '-requires',
            'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
            '-property',
            'installationPath',
        ],
        { encoding: 'utf8', windowsHide: true },
    ).trim();
    if (!installation)
        throw Error(
            'Windows native window build requires Visual Studio C++ Build Tools and the Windows SDK.',
        );
    const setup = path.join(installation, 'Common7/Tools/VsDevCmd.bat');
    await access(setup);
    const configured = execFileSync(
        process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', `call "${setup}" -no_logo -arch=x64 -host_arch=x64 >nul && set`],
        { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true },
    );
    const environment = { ...process.env };
    for (const line of configured.split(/\r?\n/)) {
        const split = line.indexOf('=');
        if (split > 0) {
            const key = line.slice(0, split);
            for (const existing of Object.keys(environment))
                if (existing.toLowerCase() === key.toLowerCase()) delete environment[existing];
            environment[key] = line.slice(split + 1);
        }
    }
    const compiler = environment.Path.split(';').map((dir) => path.join(dir, 'cl.exe'));
    let executable;
    for (const candidate of compiler) {
        try {
            await access(candidate);
            executable = candidate;
            break;
        } catch {}
    }
    if (!executable) throw Error('Visual Studio did not configure the x64 compiler.');
    const temporary = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-native-build-'));
    try {
        await mkdir(path.join(root, 'dist-electron'), { recursive: true });
        const response = path.join(temporary, 'compile.rsp');
        await writeFile(
            response,
            [
                '/nologo /LD /O2 /W4 /WX /MT /Brepro',
                `"${path.join(root, 'electron/native-window.c')}"`,
                `/Fo"${path.join(temporary, 'native-window.obj')}"`,
                '/link /Brepro comctl32.lib user32.lib',
                `/OUT:"${path.join(root, 'dist-electron/native-window.dll')}"`,
                `/IMPLIB:"${path.join(temporary, 'native-window.lib')}"`,
            ].join(' '),
        );
        execFileSync(executable, ['@' + response], {
            env: environment,
            stdio: 'pipe',
            windowsHide: true,
        });
        await access(path.join(root, 'dist-electron/native-window.dll'));
        console.log('Built Windows native message gate (x64, static runtime).');
    } catch (error) {
        if (error.stdout) process.stderr.write(error.stdout);
        if (error.stderr) process.stderr.write(error.stderr);
        throw error;
    } finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
    }
}
