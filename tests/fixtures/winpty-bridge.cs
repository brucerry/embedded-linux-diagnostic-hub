// Test-owned Windows/Git Bash OS PTY bridge. Existing winpty 0.4.3 only; no install.
// API: https://github.com/rprichard/winpty/blob/0.4.3/src/include/winpty.h
// Flags: https://github.com/rprichard/winpty/blob/0.4.3/src/include/winpty_constants.h
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
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
    public static int Run(string commandLine, string directory, int timeoutMs) {
        if (timeoutMs < 1000 || timeoutMs > 45000) throw new ArgumentOutOfRangeException("timeoutMs");
        IntPtr config=IntPtr.Zero, agent=IntPtr.Zero, spawn=IntPtr.Zero, process=IntPtr.Zero, thread=IntPtr.Zero, error;
        FileStream input=null, output=null;
        Task drain=null;
        try {
            config=winpty_config_new(0, out error); if(config==IntPtr.Zero) throw Failure("config",error);
            winpty_config_set_initial_size(config,120,40); winpty_config_set_agent_timeout(config,5000);
            agent=winpty_open(config,out error); if(agent==IntPtr.Zero) throw Failure("open",error);
            winpty_config_free(config); config=IntPtr.Zero;
            input=Pipe(winpty_conin_name(agent),FileAccess.Write); output=Pipe(winpty_conout_name(agent),FileAccess.Read);
            var outputStream=Console.OpenStandardOutput(); var pipeOutput=output;
            drain=Task.Run(()=>{var buffer=new byte[8192];int count;
                while((count=pipeOutput.Read(buffer,0,buffer.Length))>0){outputStream.Write(buffer,0,count);outputStream.Flush();}});
            spawn=winpty_spawn_config_new(3,@"C:\Program Files\Git\usr\bin\bash.exe",commandLine,directory,IntPtr.Zero,out error);
            if(spawn==IntPtr.Zero)throw Failure("spawn config",error);
            uint createError;
            if(!winpty_spawn(agent,spawn,out process,out thread,out createError,out error))throw Failure("spawn ("+createError+")",error);
            winpty_spawn_config_free(spawn);spawn=IntPtr.Zero;
            Console.Error.WriteLine("HUB_OS_PTY_OPEN {\"childPid\":"+GetProcessId(process)+",\"agentPid\":"+GetProcessId(winpty_agent_process(agent))+",\"cols\":120,\"rows\":40}");
            var pipeInput=input;
            // Only the pipes are touched on workers; winpty object RPC/free stays on this thread.
            Task.Run(()=>{try {var source=Console.OpenStandardInput();var buffer=new byte[8192];int count;
                while((count=source.Read(buffer,0,buffer.Length))>0){pipeInput.Write(buffer,0,count);pipeInput.Flush();}
                pipeInput.WriteByte(4);pipeInput.Flush();
            } catch(IOException){} catch(ObjectDisposedException){} });
            bool timedOut=WaitForSingleObject(process,(uint)timeoutMs)!=0;
            if(timedOut){TerminateProcess(process,124);WaitForSingleObject(process,2000);}
            uint code; if(!GetExitCodeProcess(process,out code))throw new IOException("Owned process exit unavailable.");
            if(!drain.Wait(3000))throw new IOException("Owned PTY output drain did not finish.");
            Console.Error.WriteLine("HUB_OS_PTY_CLOSE {\"exitCode\":"+code+",\"timedOut\":"+(timedOut?"true":"false")+",\"outputDrained\":true}");
            return timedOut ? 124 : (int)code;
        } finally {
            if(process!=IntPtr.Zero && WaitForSingleObject(process,0)!=0){TerminateProcess(process,137);WaitForSingleObject(process,2000);}
            if(spawn!=IntPtr.Zero)winpty_spawn_config_free(spawn);
            if(config!=IntPtr.Zero)winpty_config_free(config);
            if(agent!=IntPtr.Zero)winpty_free(agent);
            if(input!=null)input.Dispose();if(output!=null)output.Dispose();
            if(thread!=IntPtr.Zero)CloseHandle(thread);if(process!=IntPtr.Zero)CloseHandle(process);
        }
    }
}
