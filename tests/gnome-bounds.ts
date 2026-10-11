import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function main() {
    assert.equal(process.env.HUB_GNOME_ISOLATED, '1');
    assert.equal(process.env.HUB_GNOME_BOUNDS_ONLY, '1');
    const output = process.env.HUB_GNOME_EVIDENCE!;
    await mkdir(output, { recursive: true });
    const profile = await mkdtemp(path.join(tmpdir(), 'hub-bounds-'));
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined,
        ),
    ) as Record<string, string>;
    const desktop = await _electron.launch({
        executablePath: process.env.HUB_TEST_EXECUTABLE!,
        chromiumSandbox: true,
        env,
        args: ['--ozone-platform=wayland', `--user-data-dir=${profile}`],
        timeout: 40000,
    });
    const evaluate = (s: string) =>
        execFileSync(
            'gdbus',
            [
                'call',
                '--session',
                '--dest',
                'org.gnome.Shell',
                '--object-path',
                '/org/gnome/Shell',
                '--method',
                'org.gnome.Shell.Eval',
                JSON.stringify(s),
            ],
            { encoding: 'utf8', timeout: 5000 },
        );
    const file = path.join(output, 'bounds.json');
    try {
        const page = await desktop.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await writeFile(
            path.join(output, 'electron-bounds.json'),
            JSON.stringify(
                await desktop.evaluate(({ BrowserWindow }) => {
                    const w = BrowserWindow.getAllWindows()[0];
                    return {
                        bounds: w.getBounds(),
                        normal: w.getNormalBounds(),
                        minimum: w.getMinimumSize(),
                        content: w.getContentBounds(),
                    };
                }),
                null,
                4,
            ),
        );
        const source = `(async()=>{
   const {default:GLib}=await import('gi://GLib');const {default:Gio}=await import('gi://Gio');const {default:Meta}=await import('gi://Meta');const Main=await import('resource:///org/gnome/shell/ui/main.js');
   const ext=Main.extensionManager.lookup('diagnostic-hub-genie@diagnostichub.desktop').stateObj;
   const actor=global.get_window_actors().find(a=>ext._matches(a));const win=actor.meta_window;
   const rect=r=>[r.x,r.y,r.width,r.height];const report={ok:false,checks:[],observations:[]};
   const wait=ms=>new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
   const snap=phase=>report.observations.push({phase,frame:rect(win.get_frame_rect()),buffer:rect(win.get_buffer_rect()),actor:[actor.x,actor.y,actor.width,actor.height],scale:win.get_geometry_scale?.(),maximized:win.maximized_horizontally,minimized:win.minimized});
   const stable=async()=>{let old=rect(win.get_frame_rect()),same=0;for(let n=0;n<40;n++){await wait(100);const now=rect(win.get_frame_rect());same=JSON.stringify(now)===JSON.stringify(old)?same+1:0;old=now;if(same===6)return now;}throw Error('bounds not stable');};
   try{
    Main.overview.hide();win.activate(global.get_current_time());win.unmaximize(Meta.MaximizeFlags.BOTH);win.move_resize_frame(true,120,50,1100,760);await wait(800);
    if (${JSON.stringify(process.env.HUB_GNOME_BOUNDS_STRESS === '1')}) {
     ext._enabled=true;win.maximize(Meta.MaximizeFlags.BOTH);await wait(600);win.unmaximize(Meta.MaximizeFlags.BOTH);await wait(600);
     const resize=async(w,h)=>{const b=win.get_frame_rect();win.move_resize_frame(true,b.x,b.y,w,h);await wait(25);};
     for(let cycle=0;cycle<100;cycle++){
      win.minimize();win.minimize();await wait(35);await resize(1080+(cycle%3)*10,730);await resize(1120,770);win.activate(global.get_current_time());await wait(35);await resize(1090,740);await resize(1100,760);
      if(cycle%10===9){win.maximize(Meta.MaximizeFlags.BOTH);await wait(40);win.unmaximize(Meta.MaximizeFlags.BOTH);await wait(40);}
      const begin=GLib.get_monotonic_time();while(ext._active.size>0 && GLib.get_monotonic_time()-begin<3000000)await wait(25);
      if(ext._active.size>0)throw Error('stress failed bounded native recovery');
     }
     await stable();snap('after100stress');
    }
    for(const enabled of [false,false,true,true,false]){
     ext._enabled=enabled;win.maximize(Meta.MaximizeFlags.BOTH);await wait(600);win.unmaximize(Meta.MaximizeFlags.BOTH);await wait(600);const before=await stable();snap('before-'+enabled);
     win.maximize(Meta.MaximizeFlags.BOTH);await wait(600);snap('maximized-'+enabled);win.minimize();await wait(580);snap('minimized-'+enabled);win.activate(global.get_current_time());await wait(600);snap('restored-max-'+enabled);win.unmaximize(Meta.MaximizeFlags.BOTH);await wait(600);const after=await stable();snap('normal-after-'+enabled);
     report.checks.push({enabled,before,after,equal:JSON.stringify(before)===JSON.stringify(after)});
    }
    report.ok=report.checks.every(c=>c.equal);
   }catch(error){report.error=String(error);}finally{ext._enabled=true;Gio.File.new_for_path(${JSON.stringify(file)}).replace_contents(JSON.stringify(report),null,false,Gio.FileCreateFlags.REPLACE_DESTINATION,null);}
  })()`;
        assert.match(evaluate('void ' + source), /^\(true,/);
        await expect
            .poll(
                async () => {
                    try {
                        return JSON.parse(await readFile(file, 'utf8'));
                    } catch {
                        return null;
                    }
                },
                { timeout: 60000 },
            )
            .not.toBeNull();
        const report = JSON.parse(await readFile(file, 'utf8'));
        console.log(JSON.stringify(report));
        assert.equal(report.ok, true, report.error || 'exact bounds comparison failed');
    } finally {
        await desktop.close();
        await rm(profile, { recursive: true, force: true });
    }
}
main().catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
});
