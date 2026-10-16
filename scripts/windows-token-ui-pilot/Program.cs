using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

namespace DiagnosticHub.TokenUiPilot {
    internal sealed class LaunchContext { public string Nonce,HelperSha256,CaseRoot; public ContextFacts Parent; }
    internal sealed class DummyStarted { public ContextFacts Context; public long WindowHandle; public string Nonce; }
    internal sealed class DummyExited { public bool Acknowledged,ClosedByControl,TimedOut; public int ExitCode; }
    internal static class Program {
        static int? Win32Code(Exception error) { var native=error as System.ComponentModel.Win32Exception;return native==null?(int?)null:native.NativeErrorCode; }
        static string Describe(Exception error) { var code=Win32Code(error);return error.GetType().Name+": "+error.Message+"; HResult=0x"+error.HResult.ToString("x8")+(code.HasValue?"; Win32="+code.Value+" ("+new System.ComponentModel.Win32Exception(code.Value).Message+")":""); }
        internal static void RecordFailure(PilotResult result,Exception error) { result.Error=Describe(error);result.Win32Error=Win32Code(error); }
        internal static string Quote(string value) {
            var result=new StringBuilder("\"");int slashes=0;
            foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){result.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}result.Append('\\',slashes).Append(c);slashes=0;}
            return result.Append('\\',slashes*2).Append('"').ToString();
        }
        internal static void WriteNew(string path,object value) {
            var serializer=new JavaScriptSerializer{MaxJsonLength=4*1024*1024};
            using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var writer=new StreamWriter(file,new UTF8Encoding(false)))writer.Write(serializer.Serialize(value));
        }
        static T Read<T>(string path) { Policy.Require(new FileInfo(path).Length<=4*1024*1024,"Receipt exceeds bound");return new JavaScriptSerializer{MaxJsonLength=4*1024*1024}.Deserialize<T>(File.ReadAllText(path)); }
        static T AwaitJson<T>(string path,Process child,int milliseconds) {
            var clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<milliseconds){try{if(File.Exists(path))return Read<T>(path);}catch(IOException){}catch(ArgumentException){}Policy.Require(!child.HasExited,"Owned child exited before its receipt");Thread.Sleep(75);}throw new TimeoutException("Owned receipt did not arrive: "+Path.GetFileName(path));
        }
        static void HostedOnly() {
            // Operational guard only, not an isolation/security attestation. No local fallback.
            Policy.Require(Environment.OSVersion.Platform==PlatformID.Win32NT&&Environment.Is64BitProcess,"Windows x64 required");
            foreach(var pair in new[]{new[]{"GITHUB_ACTIONS","true"},new[]{"CI","true"},new[]{"RUNNER_ENVIRONMENT","github-hosted"},new[]{"RUNNER_OS","Windows"},new[]{"RUNNER_ARCH","X64"},new[]{"PILOT_EXECUTION_APPROVED","true"}})
                Policy.Require(String.Equals(Environment.GetEnvironmentVariable(pair[0]),pair[1],StringComparison.OrdinalIgnoreCase),"Operational pilot unavailable outside the reviewed hosted workflow: "+pair[0]);
            Policy.Require(Regex.IsMatch(Environment.GetEnvironmentVariable("GITHUB_RUN_ID")??"",@"^\d+$")&&Regex.IsMatch(Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT")??"",@"^\d+$"),"Missing hosted run identity");
            Policy.Require(Regex.IsMatch(Environment.GetEnvironmentVariable("GITHUB_SHA")??"",@"^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$"),"Missing source identity");
        }
        static string OwnExe {get{return Path.GetFullPath(Assembly.GetExecutingAssembly().Location);}}
        static LaunchContext Context(string root,string nonce) {
            Native.PlainDirectory(root);var context=Read<LaunchContext>(Path.Combine(root,"launch-context.json"));
            Policy.Require(context.Nonce==nonce&&Policy.Same(context.CaseRoot,root)&&Policy.Same(context.HelperSha256,Native.Sha(OwnExe)),"Launch context or helper hash differs");return context;
        }
        static Process StartOwn(string mode,string root,string nonce) {
            var info=new ProcessStartInfo(OwnExe,mode+" "+Quote(root)+" "+Quote(nonce));info.UseShellExecute=false;info.CreateNoWindow=true;info.WorkingDirectory=root;
            return Process.Start(info);
        }
        static int Run(string root,string nonce) {
            var result=new PilotResult {CaseRoot=root,Nonce=nonce,HelperSha256=Native.Sha(OwnExe),SourceCommit=Environment.GetEnvironmentVariable("GITHUB_SHA"),RunId=Environment.GetEnvironmentVariable("GITHUB_RUN_ID"),RunAttempt=Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT"),ImageOS=Environment.GetEnvironmentVariable("ImageOS")??"unavailable",ImageVersion=Environment.GetEnvironmentVariable("ImageVersion")??"unavailable",Stage="preflight"};
            Native.OwnedJob job=null;Native.ProcessInfo child=null;FileStream ownership=null;
            try {
                Native.PlainDirectory(root);result.Parent=new ContextFacts();using(var current=Process.GetCurrentProcess())result.Parent.Process=Native.ProcessFacts(current);
                result.Parent.Profile=Native.Profile(result.Parent.Process.Token.UserSid);result.Parent.Desktop=Native.Desktop();
                Policy.Require(root.StartsWith(Path.GetFullPath(result.Parent.Profile.Home).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase),"Case must be inside the actual existing user home");
                Policy.Require(Policy.Profile(result.Parent.Profile,result.Parent.Profile,"parent").Count==0&&Policy.Desktop(result.Parent.Desktop,result.Parent.Desktop,"parent").Count==0,"Existing profile/input desktop unavailable; no changes attempted");
                // CreateProcessAsUser may temporarily activate a launch privilege already held by the caller.
                // No explicit activation/grant API is used; unchanged-parent evidence is still mandatory.
                result.LaunchQuotaState=Policy.QuotaState(result.Parent.Process.Token);
                Policy.Require(Policy.CanAttemptLaunch(result.Parent.Process.Token),"SeIncreaseQuotaPrivilege is absent or removed; no privilege grant is permitted");
                ownership=new FileStream(Path.Combine(root,"pilot-control.lock"),FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read);
                WriteNew(Path.Combine(root,"launch-context.json"),new LaunchContext{Nonce=nonce,HelperSha256=result.HelperSha256,CaseRoot=root,Parent=result.Parent});
                result.Stage="restricted-token";
                using(var restricted=Native.Restricted(result.Parent.Process.Token)) {
                    result.Candidate=Native.Token(restricted);job=new Native.OwnedJob();
                    child=job.Start(restricted,OwnExe,"--driver "+Quote(root)+" "+Quote(nonce),root,result.Parent.Desktop.Station+"\\"+result.Parent.Desktop.Desktop);
                    using(var process=Process.GetProcessById(child.Pid))result.DriverSuspended=Native.ProcessFacts(process);
                    Policy.Require(Policy.Child(result.Parent.Process.Token,result.DriverSuspended.Token,"suspended driver").Count==0&&Policy.Same(result.DriverSuspended.Sha256,result.HelperSha256),"Actual suspended driver token/image differs");
                    result.Stage="native-ui";Native.Resume(child);
                    Policy.Require(Native.Wait(child.Process,90000),"Owned UI driver exceeded its 90-second deadline");result.DriverExitCode=Native.ExitCode(child.Process);
                    if(File.Exists(Path.Combine(root,"driver-result.json")))result.Driver=Read<DriverResult>(Path.Combine(root,"driver-result.json"));
                    var join=Stopwatch.StartNew();while(job.Active!=0&&join.ElapsedMilliseconds<5000)Thread.Sleep(50);result.JobActiveProcesses=job.Active;
                }
            } catch(Exception error) {RecordFailure(result,error);}
            finally {
                try{if(job!=null&&job.Active!=0){result.ForcedTermination=true;job.Stop();if(child!=null)Native.Wait(child.Process,5000);var end=Stopwatch.StartNew();while(job.Active!=0&&end.ElapsedMilliseconds<5000)Thread.Sleep(50);result.JobActiveProcesses=job.Active;}}catch(Exception error){result.Error=(result.Error??"")+"; owned cleanup: "+Describe(error);}
                if(job!=null&&job.SuspendedCleanupPid!=0){result.ForcedTermination=true;result.SuspendedCleanupPid=job.SuspendedCleanupPid;result.SuspendedCleanupJoined=job.SuspendedCleanupJoined;}
                if(child!=null)child.Dispose();if(job!=null)job.Dispose();if(ownership!=null)ownership.Dispose();
                try{using(var current=Process.GetCurrentProcess())result.ParentAfter=Native.ProcessFacts(current).Token;}catch(Exception error){result.Error=(result.Error??"")+"; parent recheck: "+Describe(error);}
            }
            var failures=Policy.Validate(result);
            if(!Policy.Same(result.HelperSha256,Native.Sha(OwnExe)))failures.Add("Helper bytes changed");
            if(result.Driver!=null&&Policy.Same(result.Driver.Screenshot,Path.Combine(root,"dummy-native-window.png")))try{if(!Policy.Same(result.Driver.ScreenshotSha256,Native.Sha(result.Driver.Screenshot)))failures.Add("Screenshot bytes changed");}catch(Exception error){failures.Add("Screenshot file unavailable: "+error.Message);}
            result.Failures=failures.ToArray();result.Passed=failures.Count==0;result.Stage=result.Passed?"passed-pilot-only":result.Stage;
            WriteNew(Path.Combine(root,"pilot-result.json"),result);Console.WriteLine(result.Passed?"Token/dummy UI pilot passed; installer qualification remains unrun.":"Pilot failed or environment unavailable; installer qualification remains unrun.");return result.Passed?0:1;
        }
        static AutomationElement Control(AutomationElement root,int pid,string name,ControlType type) {
            var result=root.FindFirst(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.ProcessIdProperty,pid),new PropertyCondition(AutomationElement.NameProperty,name),new PropertyCondition(AutomationElement.ControlTypeProperty,type)));
            Policy.Require(result!=null&&result.Current.IsEnabled&&!result.Current.IsOffscreen,"Owned visible UIA control unavailable: "+name);return result;
        }
        static void Invoke(AutomationElement root,ProcessFacts process,IntPtr window,string name) {
            Native.AttestWindow(window,process);var control=Control(root,process.Pid,name,ControlType.Button);((InvokePattern)control.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
        }
        static int Driver(string root,string nonce) {
            var context=Context(root,nonce);var result=new DriverResult{Stage="driver-token"};
            try {
            result.Driver=Native.Current();
            Policy.Require(Policy.Child(context.Parent.Process.Token,result.Driver.Process.Token,"driver").Count==0,"Driver is not restricted medium");
            string powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");
            result.GuardExpectedImage=powershell;result.Stage="exact-installer-guard";
            var info=new ProcessStartInfo(powershell,"-NoLogo -NoProfile -NonInteractive -Command "+Quote(Policy.GuardExpression));info.UseShellExecute=false;info.CreateNoWindow=true;info.WorkingDirectory=root;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
            using(var guard=Process.Start(info)) {
                result.ObservedGuard=Native.ProcessFacts(guard);Policy.Require(Policy.Same(result.ObservedGuard.Image,powershell)&&Policy.Child(context.Parent.Process.Token,result.ObservedGuard.Token,"guard").Count==0,"Actual PowerShell child token/image differs");
                var stdout=guard.StandardOutput.ReadToEndAsync();var stderr=guard.StandardError.ReadToEndAsync();Policy.Require(guard.WaitForExit(15000),"Guard PowerShell did not exit");Policy.Require(System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[]{stdout,stderr},5000),"Guard pipe join failed");
                result.GuardOutput=stdout.Result;result.GuardError=stderr.Result;result.GuardExited=true;result.GuardExitCode=guard.ExitCode;
                Policy.Require(result.GuardExitCode==0&&String.IsNullOrWhiteSpace(result.GuardError)&&String.Equals(result.GuardOutput.Trim(),"false",StringComparison.OrdinalIgnoreCase),"Exact installer guard did not return only false");
            }
            result.Stage="owned-dummy-uia";using(var dummy=StartOwn("--dummy",root,nonce)) {
                result.ObservedDummy=Native.ProcessFacts(dummy);Policy.Require(Policy.Child(context.Parent.Process.Token,result.ObservedDummy.Token,"dummy").Count==0&&Policy.Same(result.ObservedDummy.Sha256,context.HelperSha256),"Actual dummy token/image differs");
                var started=AwaitJson<DummyStarted>(Path.Combine(root,"dummy-started.json"),dummy,15000);Policy.Require(started.Nonce==nonce,"Dummy nonce mismatch");result.Dummy=started.Context;result.WindowHandle=started.WindowHandle;
                var handle=new IntPtr(result.WindowHandle);Native.AttestWindow(handle,result.ObservedDummy);result.OwnedWindowAttested=true;
                var window=AutomationElement.FromHandle(handle);Policy.Require(window.Current.ProcessId==dummy.Id&&!window.Current.IsOffscreen,"Owned native UIA window unavailable");result.WindowNotOffscreen=true;
                window.SetFocus();Native.SetForegroundWindow(handle);
                Invoke(window,result.ObservedDummy,handle,"Pilot confirm "+nonce);
                var wait=Stopwatch.StartNew();bool observed=false;while(wait.ElapsedMilliseconds<5000){var ack=window.FindFirst(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.ProcessIdProperty,dummy.Id),new PropertyCondition(AutomationElement.NameProperty,"ACK "+nonce)));if(ack!=null&&!ack.Current.IsOffscreen){observed=true;break;}Thread.Sleep(50);}Policy.Require(observed,"UIA invocation acknowledgment not observed");result.InvokeObserved=true;
                Native.Capture(handle,result.ObservedDummy,Path.Combine(root,"dummy-native-window.png"),result);
                Invoke(window,result.ObservedDummy,handle,"Pilot close "+nonce);result.CloseInvoked=true;Policy.Require(dummy.WaitForExit(10000),"Owned dummy did not close normally");result.DummyExited=true;result.DummyExitCode=dummy.ExitCode;
                var exit=Read<DummyExited>(Path.Combine(root,"dummy-exit.json"));Policy.Require(exit.Acknowledged&&exit.ClosedByControl&&!exit.TimedOut&&exit.ExitCode==0&&dummy.ExitCode==0,"Dummy did not confirm normal control-driven exit");
            }
            result.Stage="normal-exit";
            } catch(Exception error) {result.Error=Describe(error);result.Win32Error=Win32Code(error);}
            WriteNew(Path.Combine(root,"driver-result.json"),result);return result.Error==null?0:1;
        }
        static int Dummy(string root,string nonce) {
            var context=Context(root,nonce);var current=Native.Current();Policy.Require(Policy.Child(context.Parent.Process.Token,current.Process.Token,"dummy self").Count==0,"Dummy is not ordinary medium");
            bool ack=false,closed=false,timedOut=false;Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
            using(var form=new Form())using(var timer=new System.Windows.Forms.Timer()) {
                form.Text="DiagnosticHub token UI pilot "+nonce;form.StartPosition=FormStartPosition.CenterScreen;form.FormBorderStyle=FormBorderStyle.FixedDialog;form.MaximizeBox=false;form.MinimizeBox=false;form.ClientSize=new System.Drawing.Size(620,240);
                var heading=new Label{Text="Harmless same-user token and UIA pilot\r\nNonce: "+nonce,Left=20,Top=15,Width=580,Height=55};
                var confirm=new Button{Text="Confirm harmless action",AccessibleName="Pilot confirm "+nonce,Name="PilotConfirm",Left=20,Top=80,Width=580,Height=40};
                var state=new Label{Text="Waiting for scoped UIA invocation",AccessibleName="Waiting "+nonce,Left=20,Top=130,Width=580,Height=30};
                var close=new Button{Text="Close harmless pilot",AccessibleName="Pilot close "+nonce,Name="PilotClose",Left=20,Top=175,Width=580,Height=40};
                confirm.Click+=(sender,args)=>{ack=true;state.Text="ACK "+nonce;state.AccessibleName=state.Text;};close.Click+=(sender,args)=>{closed=true;form.Close();};
                form.Controls.AddRange(new Control[]{heading,confirm,state,close});timer.Interval=40000;timer.Tick+=(sender,args)=>{timedOut=true;form.Close();};
                form.Shown+=(sender,args)=>{WriteNew(Path.Combine(root,"dummy-started.json"),new DummyStarted{Context=current,WindowHandle=form.Handle.ToInt64(),Nonce=nonce});timer.Start();form.Activate();};
                Application.Run(form);timer.Stop();
            }
            int code=ack&&closed&&!timedOut?0:72;WriteNew(Path.Combine(root,"dummy-exit.json"),new DummyExited{Acknowledged=ack,ClosedByControl=closed,TimedOut=timedOut,ExitCode=code});return code;
        }
        [STAThread] public static int Main(string[] args) {
            try {
                if(args.Length==1&&args[0]=="--self-test")return SelfTests.Run(); // No operational/native/UI entry.
                Policy.Require(args.Length==3&&(args[0]=="--run-hosted-pilot"||args[0]=="--driver"||args[0]=="--dummy"),"Use prepare/compile or pure self-test; hosted operational mode is explicit");
                HostedOnly();string root=Path.GetFullPath(args[1]),nonce=args[2];Policy.Require(Regex.IsMatch(nonce,@"^[a-f0-9]{32}$"),"Invalid correlation nonce");
                if(args[0]=="--run-hosted-pilot")return Run(root,nonce);
                if(args[0]=="--dummy")return Dummy(root,nonce);
                int code=70;Exception failure=null;var thread=new Thread(()=>{try{code=Driver(root,nonce);}catch(Exception error){failure=error;}});thread.IsBackground=true;thread.SetApartmentState(ApartmentState.MTA);thread.Start();Policy.Require(thread.Join(65000),"UIA driver did not join; parent owned-job cleanup must fail the pilot");if(failure!=null)throw failure;return code;
            } catch(Exception error) {Console.Error.WriteLine(Describe(error));return 1;}
        }
    }
}
