using System;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;
namespace DiagnosticHub.TokenUiPilot {
    internal static class SelfTests {
        static T Copy<T>(T value) { var json = new JavaScriptSerializer(); return json.Deserialize<T>(json.Serialize(value)); }
        static TokenFacts Token() { return new TokenFacts { UserSid="S-1-5-21-1", AuthenticationId="1:2", TokenId="3:4", SessionId=1, TokenType=1, IntegrityRid=8192, ElevationType=1, HasRestrictions=true, AdminSidPresent=true, AdminDenyOnly=true, EnabledPrivileges=new[]{"SeChangeNotifyPrivilege"}, Groups=new Dictionary<string,uint>(), Privileges=new Dictionary<string,uint>{{"SeIncreaseQuotaPrivilege",0}} }; }
        static PilotResult Good() {
            var token=Token(); var profile=new ProfileFacts { Home=@"C:\Users\fixture", AppData=@"C:\Users\fixture\AppData\Roaming", LocalAppData=@"C:\Users\fixture\AppData\Local", Desktop=@"C:\Users\fixture\Desktop", LoadedHive=true, ExistingPlainDirectories=true, EnvironmentMatches=true };
            var desktop=new DesktopFacts { Station="WinSta0", Desktop="Default", InputDesktop="Default", UserInteractive=true, StationVisible=true, InputAccessible=true };
            string hash=new String('a',64);var process=new ProcessFacts { Pid=12,CreatedUtcTicks=55,Image=@"C:\pilot\pilot.exe",Sha256=hash,Token=token };
            var context=new ContextFacts { Process=process,Profile=profile,Desktop=desktop };
            var driver=Copy(context);driver.Process.Pid=20;driver.Process.CreatedUtcTicks=60;var dummy=Copy(context);dummy.Process.Pid=21;dummy.Process.CreatedUtcTicks=65;var guard=Copy(process);guard.Pid=22;guard.Image=@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
            return new PilotResult { LaunchQuotaState="held-disabled",CaseRoot=@"C:\Users\fixture\pilot",Nonce=new String('c',32),SourceCommit=new String('d',40),RunId="123",RunAttempt="1",ImageOS="win25-fixture",ImageVersion="fixture-only",Parent=context,ParentAfter=Copy(token),Candidate=Copy(token),DriverSuspended=Copy(driver.Process),HelperSha256=hash,DriverExitCode=0,JobActiveProcesses=0,Driver=new DriverResult { Driver=driver,Dummy=dummy,ObservedDummy=Copy(dummy.Process),ObservedGuard=guard,GuardExpectedImage=guard.Image,GuardOutput="False\r\n",GuardError="",GuardExited=true,DummyExited=true,DummyExitCode=0,WindowVisible=true,WindowNotMinimized=true,WindowNotOffscreen=true,OwnedWindowAttested=true,InvokeObserved=true,CloseInvoked=true,ScreenshotCaptured=true,Screenshot=@"C:\Users\fixture\pilot\dummy-native-window.png",ScreenshotSha256=new String('b',64),WindowHandle=1234,ScreenshotMethod="PrintWindow(PW_CLIENTONLY)",ScreenshotWindowHandle=1234,ScreenshotFlags=1,Width=480,Height=260 } };
        }
        static void Refuses(Action operation,string label) { bool refused=false;try{operation();}catch(InvalidOperationException){refused=true;}Policy.Require(refused,label); }
        static int CorrectionControls() {
            int count=0;var heldDisabled=Token();
            Policy.Require(Policy.QuotaState(heldDisabled)=="held-disabled"&&Policy.CanAttemptLaunch(heldDisabled),"held-disabled quota must reach the documented API attempt");count++;
            var heldEnabled=Copy(heldDisabled);heldEnabled.Privileges["SeIncreaseQuotaPrivilege"]=2;
            Policy.Require(Policy.QuotaState(heldEnabled)=="held-enabled"&&Policy.CanAttemptLaunch(heldEnabled),"held-enabled quota");count++;
            var absent=Copy(heldDisabled);absent.Privileges.Clear();Policy.Require(!Policy.CanAttemptLaunch(absent)&&Policy.QuotaState(absent)=="absent","missing quota must not be granted");count++;
            var removed=Copy(heldDisabled);removed.Privileges["SeIncreaseQuotaPrivilege"]=4;Policy.Require(!Policy.CanAttemptLaunch(removed)&&Policy.QuotaState(removed)=="removed","removed quota must not be restored");count++;
            var missing=Copy(heldDisabled);missing.Privileges=null;Policy.Require(!Policy.CanAttemptLaunch(missing),"missing inventory cannot authorize launch");count++;
            foreach(int code in new[]{1314,5}) {var refused=Good();Program.RecordFailure(refused,new System.ComponentModel.Win32Exception(code,"synthetic CreateProcessAsUser refusal"));Policy.Require(refused.Win32Error==code&&refused.Error.Contains("Win32="+code)&&Policy.Validate(refused).Any(v=>v.StartsWith("pilot-error:",StringComparison.Ordinal)),"native refusal must preserve numeric error and fail");count++;}
            var restored=Good();restored.ParentAfter.ModifiedId="changed-even-when-rights-restored";Policy.Require(Policy.Validate(restored).Contains("parent-token-changed-or-missing"),"restored final rights cannot waive a ModifiedId change");count++;
            foreach(var edit in new Action<PilotResult>[] {r=>r.LaunchQuotaState="held-enabled",r=>r.Parent.Process.Token.Privileges.Clear(),r=>r.Driver.ScreenshotMethod="CopyFromScreen",r=>r.Driver.ScreenshotWindowHandle=999,r=>r.Driver.ScreenshotFlags=0}) {var invalid=Good();edit(invalid);Policy.Require(Policy.Validate(invalid).Count>0,"incorrect launch or capture receipt accepted");count++;}
            const long owned=101,foreign=202;byte[] ownedPixels={1,2,3,4},overlaidDesktop={1,99,99,4},rendered=null,saved=null;var sequence=new List<string>();
            Policy.RenderOwnedFrame(owned,h=>{Policy.Require(h==owned,"foreign capture handle");sequence.Add("attest");},h=>{Policy.Require(h==owned&&h!=foreign,"renderer received unrelated HWND");sequence.Add("render");rendered=(byte[])ownedPixels.Clone();return true;},()=>{sequence.Add("save");saved=(byte[])rendered.Clone();});
            Policy.Require(sequence.SequenceEqual(new[]{"attest","render","attest","save"})&&saved.SequenceEqual(ownedPixels)&&!saved.SequenceEqual(overlaidDesktop),"an overlapping desktop fixture must not become the owned frame source");count++;
            int saves=0,renders=0;Refuses(()=>Policy.RenderOwnedFrame(owned,h=>{},h=>{renders++;return false;},()=>saves++),"failed window render must refuse");Policy.Require(renders==1&&saves==0,"failed render saved an image or used a fallback");count++;
            renders=0;Refuses(()=>Policy.RenderOwnedFrame(foreign,h=>Policy.Require(h==owned,"unowned HWND"),h=>{renders++;return true;},()=>saves++),"foreign HWND must refuse");Policy.Require(renders==0&&saves==0,"foreign HWND reached rendering/save");count++;
            int attestations=0;Refuses(()=>Policy.RenderOwnedFrame(owned,h=>{attestations++;Policy.Require(attestations<2,"ownership changed during render");},h=>true,()=>saves++),"lost ownership must refuse");Policy.Require(attestations==2&&saves==0,"lost ownership saved an image");count++;
            renders=0;Refuses(()=>Policy.RenderOwnedFrame(0,h=>{},h=>{renders++;return true;},()=>saves++),"null HWND must refuse");Policy.Require(renders==0&&saves==0,"null HWND reached rendering/save");count++;
            Refuses(()=>Policy.RenderOwnedFrame(owned,h=>{},h=>{throw new InvalidOperationException("renderer refused");},()=>saves++),"renderer exception must refuse");Policy.Require(saves==0,"renderer exception saved an image");count++;
            return count;
        }
        static int RestrictionDiagnosticsControls() {
            int count=0;var parent=Token();
            var edits=new Dictionary<string,Action<TokenFacts>> {
                {"same-user-sid",t=>t.UserSid="other"},{"same-authentication-id",t=>t.AuthenticationId="other"},
                {"nonzero-session",t=>t.SessionId=0},{"same-session",t=>t.SessionId=2},
                {"primary-token",t=>t.TokenType=2},{"medium-integrity",t=>t.IntegrityRid=12288},
                {"not-elevated",t=>t.Elevated=true},{"default-or-limited-elevation-type",t=>t.ElevationType=2},
                {"no-ui-access",t=>t.UiAccess=true},{"has-filtering-history",t=>t.HasRestrictions=false},
                {"administrator-role-disabled",t=>t.AdminRole=true},{"administrator-sid-not-enabled",t=>t.AdminEnabled=true},
                {"administrator-sid-absent-or-deny-only",t=>t.AdminDenyOnly=false},
                {"enabled-privileges-subset",t=>t.EnabledPrivileges=new[]{"SeDebugPrivilege"}},
                {"enabled-groups-subset",t=>t.Groups.Add("S-1-5-32-555",4)}
            };
            foreach(var edit in edits) {
                var candidate=Token();edit.Value(candidate);var trace=new RestrictionFacts{Stage="validate-candidate",BeforeIntegrity=Copy(candidate)};
                Policy.RecordRestrictionCandidate(trace,parent,candidate);
                Refuses(()=>Policy.Require(trace.ValidationFailures.Length==0,String.Join(", ",trace.ValidationFailures)),"invalid candidate must still be refused");
                Policy.Require(!trace.PredicateResults[edit.Key]&&trace.ValidationFailures.Length>0,"exact failed predicate lost");
                var result=Good();result.Candidate=null;result.Restriction=trace;result.Error="candidate rejected";Policy.AttachRestrictionCandidate(result);
                var saved=Copy(result);Policy.Require(saved.Candidate!=null&&!saved.Restriction.PredicateResults[edit.Key]&&saved.Restriction.ValidationFailures.Length>0&&Policy.Validate(saved).Count>0,"failure receipt lost facts or became passing");count++;
            }
            var valid=new RestrictionFacts();Policy.RecordRestrictionCandidate(valid,parent,Token());Policy.Require(valid.ValidationFailures.Length==0&&valid.PredicateResults.Values.All(v=>v),"valid diagnostic map disagrees with unchanged policy");count++;
            var missing=new RestrictionFacts();Policy.RecordRestrictionCandidate(missing,parent,null);Policy.Require(!missing.PredicateResults["facts-present"]&&missing.ValidationFailures.Contains("restricted:missing-token"),"missing candidate diagnostic");count++;
            var noParent=new RestrictionFacts();Policy.RecordRestrictionCandidate(noParent,null,Token());Policy.Require(!noParent.PredicateResults["facts-present"]&&noParent.ValidationFailures.Length>0,"missing input diagnostic");count++;
            var both=Token();both.Elevated=true;both.AdminEnabled=true;both.IntegritySid="S-1-16-8192";both.NativeNumbers=new Dictionary<string,int>{{"TokenElevation(20)",1},{"TokenType(8)",1}};
            var multi=new RestrictionFacts{Stage="validate-candidate",BeforeIntegrity=Token(),IntegrityLowered=true,CandidateDisposeCalledOnFailure=true};Policy.RecordRestrictionCandidate(multi,parent,both);
            Policy.Require(!multi.PredicateResults["not-elevated"]&&!multi.PredicateResults["administrator-sid-not-enabled"]&&multi.ValidationFailures.Length==2,"multiple rejection reasons lost");count++;
            var serialized=Copy(multi);Policy.Require(serialized.Candidate.NativeNumbers["TokenElevation(20)"]==1&&serialized.Candidate.IntegritySid=="S-1-16-8192"&&serialized.CandidateDisposeCalledOnFailure&&serialized.IntegrityLowered&&serialized.Stage=="validate-candidate","native diagnostics did not survive serialization");count++;
            var partial=Good();partial.Candidate=null;partial.Restriction=new RestrictionFacts{Stage="lower-new-token-integrity",BeforeIntegrity=Token()};Policy.AttachRestrictionCandidate(partial);Policy.Require(partial.Candidate==null&&partial.Restriction.BeforeIntegrity!=null,"partial pre-integrity facts were mislabeled as final candidate");count++;
            var existing=Good();var original=existing.Candidate;existing.Restriction=multi;Policy.AttachRestrictionCandidate(existing);Policy.Require(Object.ReferenceEquals(original,existing.Candidate),"later independent candidate snapshot was overwritten");count++;
            for(int mask=0;mask<256;mask++) {var candidate=Token();candidate.Elevated=(mask&1)!=0;candidate.UiAccess=(mask&2)!=0;candidate.AdminRole=(mask&4)!=0;candidate.AdminEnabled=(mask&8)!=0;candidate.AdminDenyOnly=(mask&16)==0;candidate.HasRestrictions=(mask&32)==0;candidate.TokenType=(mask&64)==0?1:2;candidate.IntegrityRid=(mask&128)==0?8192:12288;Policy.Require(Policy.CandidateChecks(parent,candidate).Values.All(v=>v)==(Policy.Child(parent,candidate,"restricted").Count==0),"diagnostic map changed security decision");}count++;
            return count;
        }
        public static int Run() {
            int count=0; var good=Good(); Policy.Require(Policy.Validate(good).Count==0,"synthetic positive"); count++;
            var edits=new Action<PilotResult>[] {
                r=>r.Candidate.AdminRole=true, r=>r.Candidate.AdminEnabled=true, r=>r.Candidate.AdminDenyOnly=false,
                r=>r.Candidate.UserSid="other", r=>r.Candidate.AuthenticationId="other", r=>r.Candidate.SessionId=0,
                r=>r.Candidate.IntegrityRid=12288, r=>r.Candidate.IntegrityRid=4096, r=>r.Candidate.Elevated=true,
                r=>r.Candidate.ElevationType=2, r=>r.Candidate.UiAccess=true, r=>r.Candidate.TokenType=2,
                r=>r.Candidate.EnabledPrivileges=new[]{"SeDebugPrivilege"}, r=>r.Driver.Dummy.Profile.LoadedHive=false,
                r=>r.Driver.Driver.Profile.Home=@"C:\fake", r=>r.Driver.Driver.Profile.EnvironmentMatches=false,
                r=>r.Driver.Dummy.Desktop.InputAccessible=false, r=>r.Driver.Driver.Desktop.Station="Service-0x0",
                r=>r.Driver.Dummy.Desktop.InputDesktop="Winlogon", r=>r.Driver.GuardOutput="true",
                r=>r.Driver.GuardOutput="false\nextra", r=>r.Driver.GuardExitCode=1, r=>r.Driver.GuardExited=false,
                r=>r.Driver.ObservedGuard.Token.AdminRole=true, r=>r.Driver.ObservedDummy.Pid=99,
                r=>r.Driver.InvokeObserved=false,r=>r.Driver.CloseInvoked=false,r=>r.Driver.ScreenshotCaptured=false,
                r=>r.Driver.WindowVisible=false,r=>r.Driver.WindowNotOffscreen=false,r=>r.Driver.DummyExited=false,
                r=>r.Driver.DummyExitCode=1,r=>r.DriverExitCode=1,r=>r.ForcedTermination=true,r=>r.JobActiveProcesses=1,
                r=>r.InstallerExecuted=true,r=>r.PilotOnly=false,r=>r.Driver=null,
                r=>r.ParentAfter.Elevated=true,r=>r.ParentAfter=null,r=>r.DriverSuspended.Pid=0,
                r=>r.DriverSuspended.CreatedUtcTicks=1,r=>r.Driver.Driver.Process.Image=@"C:\other.exe",
                r=>r.Driver.ObservedDummy.CreatedUtcTicks=1,r=>r.Driver.ObservedDummy.Image=@"C:\other.exe",
                r=>r.Driver.ObservedGuard.Image=@"C:\fake-powershell.exe",r=>r.Driver.ObservedGuard.Pid=0,
                r=>r.Driver.WindowHandle=0,r=>r.Driver.ScreenshotSha256="bad",r=>r.Driver.Width=99999,
                r=>r.Candidate.Groups.Add("S-1-5-32-555",4),r=>r.Candidate.ElevationType=0,
                r=>r.Driver.Error="UIA timeout",r=>r.Driver.Driver.Process.Pid=r.Parent.Process.Pid,
                r=>r.Error="partial failure",r=>r.SourceCommit=null,r=>r.ImageVersion="unavailable",
                r=>r.Nonce="bad",r=>r.RunAttempt="0",r=>r.CaseRoot=@"C:\outside",r=>r.Driver.Screenshot=@"C:\outside.png",
                r=>r.ParentAfter.ModifiedId="changed",r=>r.Candidate.HasRestrictions=false,
                r=>r.Win32Error=1314,r=>r.Driver.Win32Error=5
            };
            foreach(var edit in edits) { var bad=Copy(good);edit(bad);Policy.Require(Policy.Validate(bad).Count>0,"synthetic negative was accepted");count++; }
            var adminParent=Copy(good);adminParent.Parent.Process.Token.AdminRole=true;adminParent.Parent.Process.Token.AdminEnabled=true;adminParent.Parent.Process.Token.AdminDenyOnly=false;adminParent.Parent.Process.Token.Elevated=true;adminParent.Parent.Process.Token.IntegrityRid=12288;adminParent.Parent.Process.Token.ElevationType=1;adminParent.Parent.Process.Token.HasRestrictions=false;adminParent.ParentAfter=Copy(adminParent.Parent.Process.Token);Policy.Require(Policy.Validate(adminParent).Count==0,"elevated parent with reduced children");count++;
            var limited=Copy(good);limited.Candidate.ElevationType=3;Policy.Require(Policy.Validate(limited).Count==0,"limited candidate");count++;
            var absent=Copy(good);absent.Candidate.AdminSidPresent=false;absent.Candidate.AdminDenyOnly=false;Policy.Require(Policy.Validate(absent).Count==0,"admin SID absent candidate");count++;
            foreach(var pair in new[]{new[]{"","\"\""},new[]{"abc","\"abc\""},new[]{"C:\\with space\\","\"C:\\with space\\\\\""},new[]{"a\"b","\"a\\\"b\""}}){Policy.Require(Program.Quote(pair[0])==pair[1],"Windows argument quoting");count++;}
            int correctionChecks=CorrectionControls();count+=correctionChecks;
            int restrictionDiagnosticsChecks=RestrictionDiagnosticsControls();count+=restrictionDiagnosticsChecks;
            Policy.Require(Native.OperationalCalls==0,"self-test reached native pilot APIs");
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { schema="token-ui-pilot-pure-self-tests-v1",passed=count,correctionChecks=correctionChecks,restrictionDiagnosticsChecks=restrictionDiagnosticsChecks,operationalNativeCalls=Native.OperationalCalls,restrictedProcessesLaunched=0,uiWindowsCreated=0,installerExecuted=false })); return 0;
        }
    }
}
