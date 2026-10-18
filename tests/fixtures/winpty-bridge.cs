// Test-owned Windows/Git Bash OS PTY bridge. Existing winpty 0.4.3 only; no install.
// API: https://github.com/rprichard/winpty/blob/0.4.3/src/include/winpty.h
// Flags: https://github.com/rprichard/winpty/blob/0.4.3/src/include/winpty_constants.h
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Threading;
using System.Collections.Generic;
using Microsoft.Win32.SafeHandles;

public static class HubWinptyFixture {
    const string Library = "hub-fixture-winpty";
    static HubWinptyFixture() {
        var library = Environment.GetEnvironmentVariable("HUB_TEST_WINPTY_DLL");
        if (String.IsNullOrEmpty(library) || !Path.IsPathRooted(library) || !File.Exists(library))
            throw new IOException("Explicit installed winpty library is unavailable.");
        NativeLibrary.SetDllImportResolver(typeof(HubWinptyFixture).Assembly,
            (name, assembly, searchPath) => name == Library ? NativeLibrary.Load(library) : IntPtr.Zero);
    }
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr winpty_config_new(ulong flags, out IntPtr error);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern void winpty_config_free(IntPtr config);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern void winpty_config_set_initial_size(IntPtr config, int cols, int rows);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern void winpty_config_set_agent_timeout(IntPtr config, uint timeout);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr winpty_open(IntPtr config, out IntPtr error);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr winpty_conin_name(IntPtr agent);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr winpty_conout_name(IntPtr agent);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr winpty_agent_process(IntPtr agent);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Unicode)] static extern IntPtr winpty_spawn_config_new(ulong flags, string app, string command, string cwd, IntPtr env, out IntPtr error);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern void winpty_spawn_config_free(IntPtr config);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool winpty_spawn(IntPtr agent, IntPtr config, out IntPtr process, out IntPtr thread, out uint createError, out IntPtr error);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern void winpty_free(IntPtr agent);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern IntPtr winpty_error_msg(IntPtr error);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)] static extern void winpty_error_free(IntPtr error);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr handle);

    static Exception Failure(string stage, IntPtr error) {
        var message = error == IntPtr.Zero ? "Unknown native failure" : Marshal.PtrToStringUni(winpty_error_msg(error));
        if (error != IntPtr.Zero) winpty_error_free(error);
        return new IOException(stage + ": " + message);
    }
    static FileStream Pipe(IntPtr name, FileAccess access) {
        var handle = CreateFileW(Marshal.PtrToStringUni(name), access == FileAccess.Read ? 0x80000000u : 0x40000000u,
            0, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Owned winpty pipe unavailable: " + Marshal.GetLastWin32Error()); }
        return new FileStream(handle, access, 8192, false);
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CancelSynchronousIo(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    sealed class Pump {
        public Thread Thread; public IntPtr Handle; public Exception Error; public bool Eof; public volatile bool Stopping;
        public readonly ManualResetEventSlim Ready=new ManualResetEventSlim(false);
        public Pump(Action<Pump> work) { Thread=new Thread(()=>{try { if(!DuplicateHandle(GetCurrentProcess(),GetCurrentThread(),GetCurrentProcess(),out Handle,0,false,2))throw new IOException("Pump thread handle unavailable"); Ready.Set();work(this); }catch(Exception e){if(!Stopping||!(e is IOException||e is ObjectDisposedException||e is OperationCanceledException))Error=e;}finally{Ready.Set();}});Thread.Start();if(!Ready.Wait(1000))throw new IOException("Pump startup unknown"); }
        public void Stop(){Stopping=true;if(Handle!=IntPtr.Zero&&!CancelSynchronousIo(Handle)&&Marshal.GetLastWin32Error()!=1168)Error=new IOException("Pump cancel failed");}
        public bool Join(){return Thread.Join(3000)&&Error==null;}
        public bool Close(){if(Handle==IntPtr.Zero)return false;bool ok=CloseHandle(Handle);if(ok)Handle=IntPtr.Zero;return ok;}
    }
    public static bool ClosureComplete(bool bash,bool agent,bool input,bool output,bool drained,bool pipes,bool handles,bool termination) { return bash&&agent&&input&&output&&drained&&pipes&&handles&&termination; }
    public static bool ClosureContract() { for(int i=0;i<8;i++){bool[] v={true,true,true,true,true,true,true,true};v[i]=false;if(ClosureComplete(v[0],v[1],v[2],v[3],v[4],v[5],v[6],v[7]))throw new IOException("Failed closure promoted");}return ClosureComplete(true,true,true,true,true,true,true,true); }
    static long Created(IntPtr handle){long c,e,k,u;if(!GetProcessTimes(handle,out c,out e,out k,out u))throw new IOException("Owned process creation identity unavailable");return c;}
    public static int Run(string bashExecutable, string commandLine, string directory, int timeoutMs) {
        if(String.IsNullOrEmpty(bashExecutable)||!Path.IsPathRooted(bashExecutable)||!File.Exists(bashExecutable)||!String.Equals(bashExecutable,Environment.GetEnvironmentVariable("HUB_TEST_WINPTY_BASH"),StringComparison.OrdinalIgnoreCase))throw new IOException("Discovered absolute Bash executable was not preserved.");
        if(commandLine!="\""+bashExecutable+"\" --noprofile -i")throw new IOException("Bash command/application handoff differs.");
        if(timeoutMs<1000||timeoutMs>45000)throw new ArgumentOutOfRangeException("timeoutMs");
        IntPtr config=IntPtr.Zero,agent=IntPtr.Zero,agentOwned=IntPtr.Zero,spawn=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero,error;
        FileStream input=null,output=null;Pump send=null,drain=null;Stream source=null;
        bool bashJoined=false,agentJoined=false,inputJoined=false,outputJoined=false,outputDrained=false,pipesClosed=true,handlesClosed=true,termination=true,timedOut=false;
        uint code=1,bashPid=0,agentPid=0;long bashCreated=0,agentCreated=0;Exception primary=null;
        try {
            config=winpty_config_new(0,out error);if(config==IntPtr.Zero)throw Failure("config",error);
            winpty_config_set_initial_size(config,120,40);winpty_config_set_agent_timeout(config,5000);
            agent=winpty_open(config,out error);if(agent==IntPtr.Zero)throw Failure("open",error);
            var borrowed=winpty_agent_process(agent);
            if(!DuplicateHandle(GetCurrentProcess(),borrowed,GetCurrentProcess(),out agentOwned,0,false,2))throw new IOException("Owned agent handle duplication failed");
            agentPid=GetProcessId(agentOwned);agentCreated=Created(agentOwned);
            winpty_config_free(config);config=IntPtr.Zero;
            input=Pipe(winpty_conin_name(agent),FileAccess.Write);output=Pipe(winpty_conout_name(agent),FileAccess.Read);
            var target=Console.OpenStandardOutput();var pipeOutput=output;
            drain=new Pump(p=>{var b=new byte[8192];int n;while((n=pipeOutput.Read(b,0,b.Length))>0){target.Write(b,0,n);target.Flush();}p.Eof=true;});
            spawn=winpty_spawn_config_new(3,bashExecutable,commandLine,directory,IntPtr.Zero,out error);if(spawn==IntPtr.Zero)throw Failure("spawn config",error);
            uint createError;if(!winpty_spawn(agent,spawn,out process,out thread,out createError,out error))throw Failure("spawn ("+createError+")",error);
            winpty_spawn_config_free(spawn);spawn=IntPtr.Zero;bashPid=GetProcessId(process);bashCreated=Created(process);
            Console.Error.WriteLine("HUB_OS_PTY_OPEN {\"childPid\":"+bashPid+",\"childCreated\":\""+bashCreated+"\",\"agentPid\":"+agentPid+",\"agentCreated\":\""+agentCreated+"\",\"cols\":120,\"rows\":40}");
            source=Console.OpenStandardInput();var pipeInput=input;var stdin=source;
            send=new Pump(p=>{var b=new byte[8192];int n;while(!p.Stopping&&(n=stdin.Read(b,0,b.Length))>0){if(p.Stopping)break;pipeInput.Write(b,0,n);pipeInput.Flush();}if(!p.Stopping){pipeInput.WriteByte(4);pipeInput.Flush();}p.Eof=true;});
            uint wait=WaitForSingleObject(process,(uint)timeoutMs);
            if(wait==258){timedOut=true;termination=TerminateProcess(process,124);if(!termination)throw new IOException("Bash termination failed");wait=WaitForSingleObject(process,2000);}
            if(wait!=0)termination=false;bashJoined=wait==0;if(!bashJoined)throw new IOException("Bash wait unconfirmed: "+wait);
            if(!GetExitCodeProcess(process,out code)||code==259){termination=false;throw new IOException("Bash exit code unavailable");}
        } catch(Exception e){primary=e;}
        finally {
            if(process!=IntPtr.Zero&&!bashJoined){uint wait=WaitForSingleObject(process,0);if(wait==258){bool ended=TerminateProcess(process,137);termination=termination&&ended;if(ended)wait=WaitForSingleObject(process,2000);}bashJoined=wait==0;}
            if(send!=null){send.Stop();try{if(source!=null)source.Dispose();}catch{pipesClosed=false;}inputJoined=send.Join();}
            else inputJoined=true;
            if(spawn!=IntPtr.Zero)winpty_spawn_config_free(spawn);if(config!=IntPtr.Zero)winpty_config_free(config);
            // Only the RPC object is freed here. The duplicated process handle survives until actual agent wait.
            if(agent!=IntPtr.Zero){winpty_free(agent);agent=IntPtr.Zero;}
            agentJoined=agentOwned!=IntPtr.Zero&&WaitForSingleObject(agentOwned,3000)==0;
            if(drain!=null){outputJoined=drain.Thread.Join(3000);outputDrained=outputJoined&&drain.Error==null&&drain.Eof;if(!outputJoined){drain.Stop();outputJoined=drain.Join();}}
            else{outputJoined=true;outputDrained=true;}
            try{if(input!=null)input.Dispose();}catch{pipesClosed=false;}try{if(output!=null)output.Dispose();}catch{pipesClosed=false;}
            if(send!=null)handlesClosed=send.Close()&&handlesClosed;if(drain!=null)handlesClosed=drain.Close()&&handlesClosed;
            if(thread!=IntPtr.Zero)handlesClosed=CloseHandle(thread)&&handlesClosed;if(process!=IntPtr.Zero)handlesClosed=CloseHandle(process)&&handlesClosed;if(agentOwned!=IntPtr.Zero)handlesClosed=CloseHandle(agentOwned)&&handlesClosed;
        }
        bool complete=ClosureComplete(bashJoined,agentJoined,inputJoined,outputJoined,outputDrained,pipesClosed,handlesClosed,termination)&&bashPid>0&&agentPid>0&&bashCreated>0&&agentCreated>0;
        if(!complete){Console.Error.WriteLine("HUB_OS_PTY_UNCERTAIN "+(primary==null?"Native closure unconfirmed":primary.Message));while(true)Thread.Sleep(1000);}
        Console.Error.WriteLine("HUB_OS_PTY_CLOSE {\"complete\":true,\"exitCode\":"+code+",\"timedOut\":"+(timedOut?"true":"false")+",\"bashExited\":true,\"agentExited\":true,\"inputPumpJoined\":true,\"outputPumpJoined\":true,\"outputDrained\":true,\"pipesClosed\":true,\"handlesClosed\":true,\"terminationConfirmed\":true,\"childPid\":"+bashPid+",\"agentPid\":"+agentPid+",\"childCreated\":\""+bashCreated+"\",\"agentCreated\":\""+agentCreated+"\"}");
        return primary!=null?1:timedOut?124:(int)code;
    }
}
