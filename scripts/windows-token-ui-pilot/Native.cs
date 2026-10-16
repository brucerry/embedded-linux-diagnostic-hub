using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace DiagnosticHub.TokenUiPilot {
    internal sealed class KernelHandle : SafeHandleZeroOrMinusOneIsInvalid {
        public KernelHandle() : base(true) { }
        internal KernelHandle(IntPtr value) : base(true) { SetHandle(value); }
        protected override bool ReleaseHandle() { return Native.CloseHandle(handle); }
    }
    internal static class Native {
        internal static int OperationalCalls;
        static void Hit() { Interlocked.Increment(ref OperationalCalls); }
        static void Check(bool ok, string api) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), api); }
        [StructLayout(LayoutKind.Sequential)] internal struct Luid { public uint Low; public int High; public override string ToString() { return High.ToString("x8") + ":" + Low.ToString("x8"); } }
        [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] struct Privilege { public Luid Luid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] struct GroupArray { public uint Count; public SidAttributes First; }
        [StructLayout(LayoutKind.Sequential)] struct PrivilegeArray { public uint Count; public Privilege First; }
        [StructLayout(LayoutKind.Sequential)] struct Statistics { public Luid TokenId, AuthenticationId; public long Expiration; public int Type, Impersonation; public uint Charged, Available, Groups, Privileges; public Luid Modified; }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] internal struct Startup { public int Size; public string Reserved, Desktop, Title; public int X,Y,Width,Height,XChars,YChars,Fill,Flags; public short Show,Reserved2; public IntPtr ReservedBytes,StdIn,StdOut,StdErr; }
        [StructLayout(LayoutKind.Sequential)] struct RawProcessInfo { public IntPtr Process, Thread; public int Pid,Tid; }
        internal sealed class ProcessInfo : IDisposable { public KernelHandle Process,Thread; public int Pid; public void Dispose(){if(Thread!=null)Thread.Dispose();if(Process!=null)Process.Dispose();} }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
        [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }

        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool CloseHandle(IntPtr h);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out KernelHandle token);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(KernelHandle token,int kind,IntPtr buffer,int size,out int needed);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeName(string system,ref Luid luid,StringBuilder name,ref int size);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool IsTokenRestricted(KernelHandle token);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferCreateLevel(uint scope,uint level,uint flags,out IntPtr handle,IntPtr reserved);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferComputeTokenFromLevel(IntPtr level,KernelHandle original,out KernelHandle restricted,uint flags,IntPtr reserved);
        [DllImport("advapi32.dll")] static extern bool SaferCloseLevel(IntPtr handle);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
        [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(KernelHandle token,int kind,IntPtr info,int size);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder path,ref int size);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
        [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int kind,IntPtr buffer,uint bytes,out uint needed);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(KernelHandle token,string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out RawProcessInfo process);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern KernelHandle CreateJobObject(IntPtr security,string name);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(KernelHandle job,int kind,ref ExtendedLimits limits,uint bytes);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(KernelHandle job,KernelHandle process);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(KernelHandle job,int kind,out Accounting data,uint bytes,IntPtr needed);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(KernelHandle job,uint code);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(KernelHandle process,uint code);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(KernelHandle thread);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(KernelHandle handle,uint milliseconds);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(KernelHandle process,out int code);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out int pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr window,out Rect rect);
        [DllImport("user32.dll",SetLastError=true)] static extern bool GetClientRect(IntPtr window,out Rect rect);
        [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);

        internal static string Sha(string file) { using(var stream=File.OpenRead(file)) using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
        static T Info<T>(KernelHandle token,int kind,Func<IntPtr,int,T> read) {
            int length; GetTokenInformation(token,kind,IntPtr.Zero,0,out length);
            Policy.Require(length>0 && length<=1024*1024,"Invalid token information size");
            IntPtr memory=Marshal.AllocHGlobal(length);try{Check(GetTokenInformation(token,kind,memory,length,out length),"GetTokenInformation");return read(memory,length);}finally{Marshal.FreeHGlobal(memory);}
        }
        static int Number(KernelHandle token,int kind) { return Info(token,kind,(memory,length)=>Marshal.ReadInt32(memory)); }
        internal static TokenFacts Token(KernelHandle token) {
            Hit(); var value=new TokenFacts();
            value.UserSid=Info(token,1,(b,n)=>new SecurityIdentifier(Marshal.ReadIntPtr(b)).Value);
            var statistics=Info(token,10,(b,n)=>(Statistics)Marshal.PtrToStructure(b,typeof(Statistics)));
            value.AuthenticationId=statistics.AuthenticationId.ToString();value.TokenId=statistics.TokenId.ToString();value.ModifiedId=statistics.Modified.ToString();value.TokenType=statistics.Type;
            value.SessionId=Number(token,12);value.ElevationType=Number(token,18);value.Elevated=Number(token,20)!=0;value.HasRestrictions=Number(token,21)!=0;value.UiAccess=Number(token,26)!=0;value.IsRestricted=IsTokenRestricted(token);
            value.IntegrityRid=Info(token,25,(b,n)=>Int32.Parse(new SecurityIdentifier(Marshal.ReadIntPtr(b)).Value.Split('-').Last()));
            using(var identity=new WindowsIdentity(token.DangerousGetHandle())) value.AdminRole=new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            value.Groups=Info(token,2,(b,n)=>{var result=new Dictionary<string,uint>();int count=Marshal.ReadInt32(b),offset=Marshal.OffsetOf(typeof(GroupArray),"First").ToInt32(),size=Marshal.SizeOf(typeof(SidAttributes));Policy.Require(count>=0&&count<=4096&&offset+(long)count*size<=n,"Token groups bound");for(int i=0;i<count;i++){var item=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(b,offset+i*size),typeof(SidAttributes));result.Add(new SecurityIdentifier(item.Sid).Value,item.Attributes);}return result;});
            uint admin;value.AdminSidPresent=value.Groups.TryGetValue("S-1-5-32-544",out admin);value.AdminEnabled=(admin&4)!=0;value.AdminDenyOnly=(admin&16)!=0;
            value.Privileges=Info(token,3,(b,n)=>{var result=new Dictionary<string,uint>();int count=Marshal.ReadInt32(b),offset=Marshal.OffsetOf(typeof(PrivilegeArray),"First").ToInt32(),size=Marshal.SizeOf(typeof(Privilege));Policy.Require(count>=0&&count<=4096&&offset+(long)count*size<=n,"Token privileges bound");for(int i=0;i<count;i++){var item=(Privilege)Marshal.PtrToStructure(IntPtr.Add(b,offset+i*size),typeof(Privilege));int length=0;LookupPrivilegeName(null,ref item.Luid,null,ref length);Policy.Require(length>0&&length<512,"Privilege name bound");var name=new StringBuilder(length+1);length=name.Capacity;Check(LookupPrivilegeName(null,ref item.Luid,name,ref length),"LookupPrivilegeName");result.Add(name.ToString(),item.Attributes);}return result;});
            value.EnabledPrivileges=value.Privileges.Where(v=>(v.Value&2)!=0).Select(v=>v.Key).OrderBy(v=>v,StringComparer.Ordinal).ToArray();return value;
        }
        internal static ProcessFacts ProcessFacts(Process process) {
            Hit();var image=new StringBuilder(32768);int size=image.Capacity;Check(QueryFullProcessImageName(process.Handle,0,image,ref size),"QueryFullProcessImageName");long created,exit,kernel,user;Check(GetProcessTimes(process.Handle,out created,out exit,out kernel,out user),"GetProcessTimes");
            KernelHandle token;Check(OpenProcessToken(process.Handle,10,out token),"OpenProcessToken(query and duplicate for WindowsPrincipal)");using(token)return new ProcessFacts{Pid=process.Id,CreatedUtcTicks=DateTime.FromFileTimeUtc(created).Ticks,Image=Path.GetFullPath(image.ToString()),Sha256=Sha(image.ToString()),Token=Token(token)};
        }
        internal static void PlainDirectory(string path) {
            Policy.Require(Path.IsPathRooted(path)&&!path.StartsWith(@"\\",StringComparison.Ordinal),"Local rooted directory required");
            for(var item=new DirectoryInfo(Path.GetFullPath(path));item!=null;item=item.Parent)Policy.Require(item.Exists&&(item.Attributes&FileAttributes.ReparsePoint)==0,"Missing or reparse directory: "+item.FullName);
        }
        internal static ProfileFacts Profile(string sid) {
            Hit();var value=new ProfileFacts {Home=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),AppData=Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),LocalAppData=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),Desktop=Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)};
            foreach(var path in new[]{value.Home,value.AppData,value.LocalAppData,value.Desktop})PlainDirectory(path);
            using(var key=Registry.Users.OpenSubKey(sid,false))value.LoadedHive=key!=null;
            value.ExistingPlainDirectories=true;value.EnvironmentMatches=Policy.Same(value.Home,Environment.GetEnvironmentVariable("USERPROFILE"))&&Policy.Same(value.AppData,Environment.GetEnvironmentVariable("APPDATA"))&&Policy.Same(value.LocalAppData,Environment.GetEnvironmentVariable("LOCALAPPDATA"));return value;
        }
        static string ObjectName(IntPtr handle) {
            uint length;GetUserObjectInformation(handle,2,IntPtr.Zero,0,out length);Policy.Require(length>0&&length<4096,"Desktop name bound");IntPtr memory=Marshal.AllocHGlobal((int)length);try{Check(GetUserObjectInformation(handle,2,memory,length,out length),"GetUserObjectInformation(name)");return Marshal.PtrToStringUni(memory);}finally{Marshal.FreeHGlobal(memory);}
        }
        internal static DesktopFacts Desktop() {
            Hit();IntPtr station=GetProcessWindowStation(),desktop=GetThreadDesktop(GetCurrentThreadId()),input=OpenInputDesktop(0,false,1);Check(input!=IntPtr.Zero,"OpenInputDesktop(read only)");
            IntPtr flags=Marshal.AllocHGlobal(12);try{uint size;Check(GetUserObjectInformation(station,1,flags,12,out size),"GetUserObjectInformation(flags)");return new DesktopFacts{Station=ObjectName(station),Desktop=ObjectName(desktop),InputDesktop=ObjectName(input),UserInteractive=Environment.UserInteractive,StationVisible=(Marshal.ReadInt32(flags,8)&1)!=0,InputAccessible=true};}finally{Marshal.FreeHGlobal(flags);CloseDesktop(input);}
        }
        internal static ContextFacts Current() { using(var process=Process.GetCurrentProcess()){var facts=ProcessFacts(process);return new ContextFacts{Process=facts,Profile=Profile(facts.Token.UserSid),Desktop=Desktop()};} }
        internal static KernelHandle Restricted(TokenFacts parent) {
            Hit();KernelHandle original;using(var process=Process.GetCurrentProcess())Check(OpenProcessToken(process.Handle,11,out original),"OpenProcessToken(primary query/duplicate/assign)");
            using(original){IntPtr level;Check(SaferCreateLevel(2,0x20000,1,out level,IntPtr.Zero),"SaferCreateLevel(NORMALUSER)");try{KernelHandle result;Check(SaferComputeTokenFromLevel(level,original,out result,0,IntPtr.Zero),"SaferComputeTokenFromLevel(flags=0)");try{var before=Token(result);Policy.Require(before.IntegrityRid>=8192,"Refuse to raise a low-integrity token");if(before.IntegrityRid>8192){IntPtr sid;Check(ConvertStringSidToSid("S-1-16-8192",out sid),"ConvertStringSidToSid");int labelSize=Marshal.SizeOf(typeof(SidAttributes)),sidSize=GetLengthSid(sid);IntPtr label=Marshal.AllocHGlobal(labelSize+sidSize);try{var bytes=new byte[sidSize];Marshal.Copy(sid,bytes,0,sidSize);IntPtr embedded=IntPtr.Add(label,labelSize);Marshal.Copy(bytes,0,embedded,sidSize);Marshal.StructureToPtr(new SidAttributes{Sid=embedded,Attributes=32},label,false);Check(SetTokenInformation(result,25,label,labelSize+sidSize),"SetTokenInformation(new child integrity only)");}finally{Marshal.FreeHGlobal(label);LocalFree(sid);}}Policy.Require(Policy.Child(parent,Token(result),"restricted").Count==0,"Restricted token does not meet ordinary medium criteria");return result;}catch{result.Dispose();throw;}}finally{SaferCloseLevel(level);}}
        }
        internal sealed class OwnedJob : IDisposable {
            KernelHandle job;
            internal int SuspendedCleanupPid;
            internal bool SuspendedCleanupJoined;
            internal OwnedJob() { Hit();job=CreateJobObject(IntPtr.Zero,null);Check(!job.IsInvalid,"CreateJobObject");var limits=new ExtendedLimits();limits.Basic.Flags=0x2000;try{Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))),"SetInformationJobObject(kill on close)");}catch{job.Dispose();throw;} }
            internal int Active {get{Accounting value;Check(QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"QueryInformationJobObject");return (int)value.Active;}}
            internal void Stop() { Check(TerminateJobObject(job,70),"TerminateJobObject(owned pilot only)"); }
            internal ProcessInfo Start(KernelHandle token,string exe,string arguments,string cwd,string desktop) {
                var startup=new Startup();startup.Size=Marshal.SizeOf(typeof(Startup));startup.Desktop=desktop;RawProcessInfo raw;
                Check(CreateProcessAsUser(token,exe,new StringBuilder(Program.Quote(exe)+" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x4|0x400|0x08000000,IntPtr.Zero,cwd,ref startup,out raw),"CreateProcessAsUserW(same user, suspended, no inherited handles)");
                var info=new ProcessInfo{Process=new KernelHandle(raw.Process),Thread=new KernelHandle(raw.Thread),Pid=raw.Pid};
                if(!AssignProcessToJobObject(job,info.Process)){int error=Marshal.GetLastWin32Error();SuspendedCleanupPid=info.Pid;try{Check(TerminateProcess(info.Process,70),"TerminateProcess(owned suspended child after job assignment failure)");SuspendedCleanupJoined=WaitForSingleObject(info.Process,5000)==0;Policy.Require(SuspendedCleanupJoined,"Owned suspended child did not join after termination");}finally{info.Dispose();}throw new Win32Exception(error,"AssignProcessToJobObject; owned suspended child forcibly stopped and joined");}return info;
            }
            public void Dispose(){if(job!=null)job.Dispose();}
        }
        internal static void Resume(ProcessInfo info){Check(ResumeThread(info.Thread)!=UInt32.MaxValue,"ResumeThread(owned child)");}
        internal static bool Wait(KernelHandle process,int milliseconds){uint value=WaitForSingleObject(process,(uint)milliseconds);Policy.Require(value==0||value==258,"WaitForSingleObject failed");return value==0;}
        internal static int ExitCode(KernelHandle process){int value;Check(GetExitCodeProcess(process,out value),"GetExitCodeProcess");return value;}
        internal static void AttestWindow(IntPtr handle,ProcessFacts process) {int pid=0;Policy.Require(handle!=IntPtr.Zero&&GetWindowThreadProcessId(handle,out pid)!=0&&pid==process.Pid,"Window not owned by attested dummy");using(var live=Process.GetProcessById(pid)){var actual=ProcessFacts(live);Policy.Require(actual.CreatedUtcTicks==process.CreatedUtcTicks&&Policy.Same(actual.Image,process.Image)&&Policy.Same(actual.Sha256,process.Sha256),"Dummy process identity changed");} }
        internal static void Capture(IntPtr handle,ProcessFacts process,string file,DriverResult result) {
            Hit();AttestWindow(handle,process);
            Rect client;Check(GetClientRect(handle,out client),"GetClientRect");
            int width=client.Right-client.Left,height=client.Bottom-client.Top;
            Policy.Require(width>=100&&height>=100&&width<=2000&&height<=2000,"Dummy client bitmap bounds unsupported");
            Policy.Require(!File.Exists(file),"Screenshot already exists");
            using(var image=new Bitmap(width,height,PixelFormat.Format32bppRgb))
            using(var graphics=Graphics.FromImage(image)) {
                // Deterministic opaque initialization; no pixels are read from a desktop/screen DC.
                graphics.Clear(Color.White);
                Policy.RenderOwnedFrame(handle.ToInt64(),
                    owned=>{
                        Policy.Require(new IntPtr(owned)==handle,"Capture HWND changed");AttestWindow(handle,process);
                        Policy.Require(IsWindowVisible(handle)&&!IsIconic(handle)&&GetForegroundWindow()==handle,"Owned dummy must remain visible, restored and foreground");
                        Rect outer,current;Check(GetWindowRect(handle,out outer),"GetWindowRect");Check(GetClientRect(handle,out current),"GetClientRect(recheck)");
                        Policy.Require(current.Right-current.Left==width&&current.Bottom-current.Top==height&&System.Windows.Forms.SystemInformation.VirtualScreen.Contains(Rectangle.FromLTRB(outer.Left,outer.Top,outer.Right,outer.Bottom)),"Owned window geometry changed or is outside the visible desktop");
                    },
                    owned=>{IntPtr dc=graphics.GetHdc();try{return PrintWindow(new IntPtr(owned),dc,1);}finally{graphics.ReleaseHdc(dc);}},
                    ()=>{using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None))image.Save(output,ImageFormat.Png);});
            }
            result.Width=width;result.Height=height;result.Screenshot=file;result.ScreenshotSha256=Sha(file);result.ScreenshotCaptured=true;result.WindowVisible=true;result.WindowNotMinimized=true;
            result.ScreenshotMethod="PrintWindow(PW_CLIENTONLY)";result.ScreenshotWindowHandle=handle.ToInt64();result.ScreenshotFlags=1;
        }
    }
}
