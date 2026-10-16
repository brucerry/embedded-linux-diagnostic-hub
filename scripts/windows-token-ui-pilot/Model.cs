using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Web.Script.Serialization;

namespace DiagnosticHub.TokenUiPilot {
    public sealed class TokenFacts {
        public string UserSid, AuthenticationId, TokenId, ModifiedId;
        public string IntegritySid;
        public Dictionary<string, int> NativeNumbers;
        public int SessionId, TokenType, IntegrityRid, ElevationType;
        public bool Elevated, AdminRole, AdminSidPresent, AdminEnabled, AdminDenyOnly, UiAccess;
        public bool IsRestricted, HasRestrictions;
        public string[] EnabledPrivileges;
        public Dictionary<string, uint> Groups;
        public Dictionary<string, uint> Privileges;
    }
    public sealed class ProfileFacts {
        public string Home, AppData, LocalAppData, Desktop;
        public bool LoadedHive, ExistingPlainDirectories, EnvironmentMatches;
    }
    public sealed class DesktopFacts {
        public string Station, Desktop, InputDesktop;
        public bool UserInteractive, StationVisible, InputAccessible;
    }
    public sealed class ProcessFacts {
        public int Pid;
        public long CreatedUtcTicks;
        public string Image, Sha256;
        public TokenFacts Token;
    }
    public sealed class ContextFacts {
        public ProcessFacts Process;
        public ProfileFacts Profile;
        public DesktopFacts Desktop;
    }
    public sealed class RestrictionFacts {
        public string Stage = "not-started";
        public TokenFacts Input, BeforeIntegrity, Candidate;
        public Dictionary<string, bool> PredicateResults;
        public string[] ValidationFailures;
        public bool IntegrityLowered, CandidateDisposeCalledOnFailure;
    }
    public sealed class DriverResult {
        public ContextFacts Driver, Dummy;
        public ProcessFacts ObservedDummy, ObservedGuard;
        public string GuardOutput, GuardError, Screenshot, ScreenshotSha256, GuardExpectedImage, Stage, Error;
        public string ScreenshotMethod;
        public long ScreenshotWindowHandle;
        public int ScreenshotFlags;
        public int? Win32Error;
        public int GuardExitCode, DummyExitCode;
        public bool GuardExited, DummyExited, WindowVisible, WindowNotMinimized, WindowNotOffscreen;
        public bool OwnedWindowAttested, InvokeObserved, CloseInvoked, ScreenshotCaptured;
        public long WindowHandle;
        public int Width, Height;
    }
    public sealed class PilotResult {
        public string Schema = "diagnostic-hub-token-ui-pilot-v1";
        public bool PilotOnly = true, InstallerExecuted = false, Passed, ForcedTermination;
        public string Stage, Error, HelperSha256, SourceCommit, RunId, RunAttempt, ImageOS, ImageVersion;
        public string LaunchQuotaState;
        public int? Win32Error;
        public string CaseRoot, Nonce;
        public ContextFacts Parent;
        public RestrictionFacts Restriction;
        public TokenFacts ParentAfter, Candidate;
        public ProcessFacts DriverSuspended;
        public DriverResult Driver;
        public int DriverExitCode = -1, JobActiveProcesses = -1;
        public int SuspendedCleanupPid;
        public bool SuspendedCleanupJoined;
        public string[] Failures;
    }
    public static class Policy {
        // Byte-for-byte expression used by the unchanged installer worker.
        public const string GuardExpression = "$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
        public static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
        public static string QuotaState(TokenFacts token) {
            uint attributes;
            if(token==null || token.Privileges==null || !token.Privileges.TryGetValue("SeIncreaseQuotaPrivilege",out attributes)) return "absent";
            if((attributes & 4)!=0) return "removed";
            return (attributes & 2)!=0 ? "held-enabled" : "held-disabled";
        }
        public static bool CanAttemptLaunch(TokenFacts token) { var state=QuotaState(token);return state=="held-enabled" || state=="held-disabled"; }
        // Pure sequencing seam: the renderer accepts only the attested HWND, never a desktop source.
        public static void RenderOwnedFrame(long handle,Action<long> attest,Func<long,bool> render,Action save) {
            Require(handle!=0,"Owned capture needs a nonzero HWND");
            attest(handle);
            Require(render(handle),"Owned PrintWindow client render failed; no screenshot saved");
            attest(handle);
            save();
        }
        public static bool Same(string a, string b) { return !String.IsNullOrEmpty(a) && String.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        public static bool Hash(string value) { return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-f0-9]{64}$"); }
        public static bool ProcessIdentity(ProcessFacts a, ProcessFacts b) {
            return a != null && b != null && a.Pid > 0 && a.CreatedUtcTicks > 0 && a.Pid == b.Pid && a.CreatedUtcTicks == b.CreatedUtcTicks && Same(a.Image,b.Image) && Hash(a.Sha256) && Same(a.Sha256,b.Sha256);
        }
        public static string TokenSnapshot(TokenFacts token) {
            if(token == null) return "null";
            var copy = new JavaScriptSerializer().Deserialize<TokenFacts>(new JavaScriptSerializer().Serialize(token));
            copy.Groups = copy.Groups == null ? null : copy.Groups.OrderBy(v=>v.Key,StringComparer.Ordinal).ToDictionary(v=>v.Key,v=>v.Value);
            copy.Privileges = copy.Privileges == null ? null : copy.Privileges.OrderBy(v=>v.Key,StringComparer.Ordinal).ToDictionary(v=>v.Key,v=>v.Value);
            copy.NativeNumbers = copy.NativeNumbers == null ? null : copy.NativeNumbers.OrderBy(v=>v.Key,StringComparer.Ordinal).ToDictionary(v=>v.Key,v=>v.Value);
            copy.EnabledPrivileges = copy.EnabledPrivileges == null ? null : copy.EnabledPrivileges.OrderBy(v=>v,StringComparer.Ordinal).ToArray();
            return new JavaScriptSerializer().Serialize(copy);
        }
        public static List<string> Child(TokenFacts parent, TokenFacts child, string label) {
            var errors = new List<string>();
            if (parent == null || child == null) { errors.Add(label + ":missing-token"); return errors; }
            if (!Same(parent.UserSid, child.UserSid) || !Same(parent.AuthenticationId, child.AuthenticationId)) errors.Add(label + ":different-user-or-logon");
            if (child.SessionId <= 0 || child.SessionId != parent.SessionId) errors.Add(label + ":session");
            if (child.TokenType != 1 || child.IntegrityRid != 8192 || child.Elevated || (child.ElevationType != 1 && child.ElevationType != 3) || child.UiAccess) errors.Add(label + ":not-ordinary-medium-primary");
            if(!child.HasRestrictions) errors.Add(label+":not-filtered");
            if (child.AdminRole || child.AdminEnabled || (child.AdminSidPresent && !child.AdminDenyOnly)) errors.Add(label + ":administrator-sid-enabled-or-ambiguous");
            if (parent.EnabledPrivileges == null || child.EnabledPrivileges == null || child.EnabledPrivileges.Any(v => !parent.EnabledPrivileges.Contains(v, StringComparer.Ordinal))) errors.Add(label + ":privilege-expansion");
            if(parent.Groups == null || child.Groups == null || child.Groups.Any(v => (v.Value & 4) != 0 && (v.Value & 32) == 0 && (!parent.Groups.ContainsKey(v.Key) || (parent.Groups[v.Key] & 4) == 0 || (parent.Groups[v.Key] & 16) != 0))) errors.Add(label + ":enabled-group-expansion");
            return errors;
        }
        // Diagnostics only. Child remains the unchanged authority for candidate acceptance.
        public static Dictionary<string, bool> CandidateChecks(TokenFacts parent, TokenFacts child) {
            var checks = new Dictionary<string, bool>();
            checks["facts-present"] = parent != null && child != null;
            if (!checks["facts-present"]) return checks;
            checks["same-user-sid"] = Same(parent.UserSid, child.UserSid);
            checks["same-authentication-id"] = Same(parent.AuthenticationId, child.AuthenticationId);
            checks["nonzero-session"] = child.SessionId > 0;
            checks["same-session"] = child.SessionId == parent.SessionId;
            checks["primary-token"] = child.TokenType == 1;
            checks["medium-integrity"] = child.IntegrityRid == 8192;
            checks["not-elevated"] = !child.Elevated;
            checks["default-or-limited-elevation-type"] = child.ElevationType == 1 || child.ElevationType == 3;
            checks["no-ui-access"] = !child.UiAccess;
            checks["has-filtering-history"] = child.HasRestrictions;
            checks["administrator-role-disabled"] = !child.AdminRole;
            checks["administrator-sid-not-enabled"] = !child.AdminEnabled;
            checks["administrator-sid-absent-or-deny-only"] = !child.AdminSidPresent || child.AdminDenyOnly;
            checks["enabled-privileges-subset"] = parent.EnabledPrivileges != null && child.EnabledPrivileges != null && !child.EnabledPrivileges.Any(v => !parent.EnabledPrivileges.Contains(v, StringComparer.Ordinal));
            checks["enabled-groups-subset"] = parent.Groups != null && child.Groups != null && !child.Groups.Any(v => (v.Value & 4) != 0 && (v.Value & 32) == 0 && (!parent.Groups.ContainsKey(v.Key) || (parent.Groups[v.Key] & 4) == 0 || (parent.Groups[v.Key] & 16) != 0));
            return checks;
        }
        public static void RecordRestrictionCandidate(RestrictionFacts trace, TokenFacts parent, TokenFacts candidate) {
            Require(trace != null, "Restriction trace is required");
            trace.Candidate = candidate;
            trace.PredicateResults = CandidateChecks(parent, candidate);
            trace.ValidationFailures = Child(parent, candidate, "restricted").ToArray();
        }
        public static void AttachRestrictionCandidate(PilotResult result) {
            if (result.Candidate == null && result.Restriction != null && result.Restriction.Candidate != null)
                result.Candidate = result.Restriction.Candidate;
        }
        public static List<string> Profile(ProfileFacts expected, ProfileFacts actual, string label) {
            var e = new List<string>();
            if (expected == null || actual == null) { e.Add(label + ":missing-profile"); return e; }
            if (!actual.LoadedHive || !actual.ExistingPlainDirectories || !actual.EnvironmentMatches) e.Add(label + ":profile-unavailable-or-redirected");
            if (!Same(expected.Home, actual.Home) || !Same(expected.AppData, actual.AppData) || !Same(expected.LocalAppData, actual.LocalAppData) || !Same(expected.Desktop, actual.Desktop)) e.Add(label + ":different-profile-paths");
            return e;
        }
        public static List<string> Desktop(DesktopFacts expected, DesktopFacts actual, string label) {
            var e = new List<string>();
            if (expected == null || actual == null) { e.Add(label + ":missing-desktop"); return e; }
            if (!actual.UserInteractive || !actual.StationVisible || !actual.InputAccessible || !Same(actual.Station, "WinSta0") || !Same(actual.Desktop, actual.InputDesktop)) e.Add(label + ":desktop-unavailable");
            if (!Same(expected.Station, actual.Station) || !Same(expected.Desktop, actual.Desktop)) e.Add(label + ":different-desktop");
            return e;
        }
        public static List<string> Validate(PilotResult result) {
            var e = new List<string>();
            if (result == null || result.Parent == null || result.Parent.Process == null) { e.Add("missing-parent"); return e; }
            if (result.Schema != "diagnostic-hub-token-ui-pilot-v1" || !result.PilotOnly || result.InstallerExecuted) e.Add("not-pilot-only");
            if(!String.IsNullOrEmpty(result.Error) || result.Win32Error.HasValue) e.Add("pilot-error:"+result.Error);
            if(!System.Text.RegularExpressions.Regex.IsMatch(result.SourceCommit??"", "^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$" ) || !System.Text.RegularExpressions.Regex.IsMatch(result.RunId??"", "^[1-9][0-9]*$") || !System.Text.RegularExpressions.Regex.IsMatch(result.RunAttempt??"", "^[1-9][0-9]*$") || String.IsNullOrWhiteSpace(result.ImageOS) || String.IsNullOrWhiteSpace(result.ImageVersion) || result.ImageOS=="unavailable" || result.ImageVersion=="unavailable" || !System.Text.RegularExpressions.Regex.IsMatch(result.Nonce??"", "^[a-f0-9]{32}$")) e.Add("hosted-provenance-incomplete");
            if(String.IsNullOrEmpty(result.CaseRoot) || result.Parent.Profile==null || String.IsNullOrEmpty(result.Parent.Profile.Home) || !result.CaseRoot.StartsWith(result.Parent.Profile.Home.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) e.Add("case-outside-real-home");
            var parent = result.Parent.Process.Token;
            if(!CanAttemptLaunch(parent) || result.LaunchQuotaState!=QuotaState(parent)) e.Add("launch-privilege-absent-or-state-mismatch");
            if(parent == null || result.ParentAfter == null || TokenSnapshot(parent) != TokenSnapshot(result.ParentAfter)) e.Add("parent-token-changed-or-missing");
            if(!Hash(result.HelperSha256) || !Same(result.HelperSha256,result.Parent.Process.Sha256)) e.Add("parent-image");
            e.AddRange(Child(parent, result.Candidate, "candidate"));
            e.AddRange(Profile(result.Parent.Profile, result.Parent.Profile, "parent"));
            e.AddRange(Desktop(result.Parent.Desktop, result.Parent.Desktop, "parent"));
            if (result.DriverSuspended == null || !Same(result.HelperSha256, result.DriverSuspended.Sha256)) e.Add("driver-image");
            else e.AddRange(Child(parent, result.DriverSuspended.Token, "suspended-driver"));
            if (result.Driver == null || result.Driver.Driver == null || result.Driver.Dummy == null) { e.Add("missing-ui-receipt"); return e; }
            var d = result.Driver;
            if(d.ScreenshotMethod!="PrintWindow(PW_CLIENTONLY)" || d.ScreenshotWindowHandle!=d.WindowHandle || d.ScreenshotFlags!=1) e.Add("not-owned-client-capture");
            if(String.IsNullOrEmpty(result.CaseRoot) || !Same(d.Screenshot,Path.Combine(result.CaseRoot,"dummy-native-window.png"))) e.Add("screenshot-outside-owned-case");
            if(!String.IsNullOrEmpty(d.Error) || d.Win32Error.HasValue) e.Add("driver-error:"+d.Error);
            if(!ProcessIdentity(result.DriverSuspended,d.Driver.Process)) e.Add("driver-attestation");
            foreach (var context in new[] { d.Driver, d.Dummy }) {
                if (context.Process == null) { e.Add("missing-child-process"); continue; }
                e.AddRange(Child(parent, context.Process.Token, "child"));
                e.AddRange(Profile(result.Parent.Profile, context.Profile, "child"));
                e.AddRange(Desktop(result.Parent.Desktop, context.Desktop, "child"));
                if (!Same(context.Process.Sha256, result.HelperSha256)) e.Add("child-image");
            }
            if (!ProcessIdentity(d.ObservedDummy,d.Dummy.Process) || !Same(d.ObservedDummy == null ? null : d.ObservedDummy.Sha256, result.HelperSha256)) e.Add("dummy-attestation");
            if (d.ObservedGuard == null || d.ObservedGuard.Pid <= 0 || d.ObservedGuard.CreatedUtcTicks <= 0 || !Hash(d.ObservedGuard.Sha256) || !Same(d.ObservedGuard.Image,d.GuardExpectedImage)) e.Add("guard-token-or-image-missing"); else e.AddRange(Child(parent, d.ObservedGuard.Token, "guard"));
            if(d.Driver.Process != null && d.Dummy.Process != null && (d.Driver.Process.Pid == d.Dummy.Process.Pid || d.Driver.Process.Pid == result.Parent.Process.Pid || d.Dummy.Process.Pid == result.Parent.Process.Pid || (d.ObservedGuard != null && (d.ObservedGuard.Pid == d.Driver.Process.Pid || d.ObservedGuard.Pid == d.Dummy.Process.Pid)))) e.Add("child-pids-not-distinct");
            if (!d.GuardExited || d.GuardExitCode != 0 || !String.IsNullOrWhiteSpace(d.GuardError) || !String.Equals((d.GuardOutput ?? "").Trim(), "false", StringComparison.OrdinalIgnoreCase)) e.Add("exact-installer-guard-refused");
            if (d.WindowHandle == 0 || !d.OwnedWindowAttested || !d.WindowVisible || !d.WindowNotMinimized || !d.WindowNotOffscreen || !d.InvokeObserved || !d.CloseInvoked || !d.ScreenshotCaptured || !Hash(d.ScreenshotSha256) || String.IsNullOrEmpty(d.Screenshot) || d.Width < 100 || d.Height < 100 || d.Width > 2000 || d.Height > 2000) e.Add("native-ui-incomplete");
            if (!d.DummyExited || d.DummyExitCode != 0 || result.DriverExitCode != 0 || result.ForcedTermination || result.JobActiveProcesses != 0) e.Add("not-normal-clean-exit");
            return e;
        }
    }
}
