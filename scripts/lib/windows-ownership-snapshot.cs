// Proposed Windows-only metadata observer. No setter, file-content read, process launch or admission.
// C# 5 / .NET Framework 4.8, loaded only by the bounded WinPS metadata command.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace HubOwnershipSnapshot {
    public sealed class SidAttributes { public string sid; public uint attributes; }
    public sealed class PrivilegeFact { public string name; public bool present; public uint attributes; }
    public sealed class TokenFacts {
        public string source, user, owner, primaryGroup, integrity, defaultDaclSddl;
        public uint userAttributes, tokenType, isAppContainer, virtualizationEnabled;
        public uint? impersonationLevel;
        public SidAttributes[] groups, restrictedSids;
        public PrivilegeFact[] relevantPrivileges;
        public uint[] unsupportedContextCounts;
    }
    public sealed class AceFact { public int type, flags; public string sid; public long? mask; }
    public sealed class NodeFact {
        public string path, volume, fileId, fileSystem, sddl;
        public uint grantedMaximum;
        public bool daclPresent, daclNull, accessCheckSucceeded, accessStatus, identityRechecked, descriptorRechecked;
        public AceFact[] aces;
        public int privilegesUsed;
        public int[] unsupportedAceTypes, unsupportedSaclTypes;
    }
    public sealed class Result {
        public int schema = 2;
        public string profile = "local-ntfs-reduced-token-snapshot-v2";
        public TokenFacts token;
        public NodeFact[] nodes = new NodeFact[0];
        public bool tokenProjectionComplete, snapshotConsistent, tokenRechecked, pinsHeldDuringSnapshot, handleClosureComplete;
        public int errorCount;
        public bool directorySelected = false, privatePathApproved = false, admissionChanged = false;
        public bool protectionAfterReturn = false, kernelWriteabilityDetermined = false;
        public string accessScope = "AccessCheck MAXIMUM_ALLOWED with actual impersonation token; DACL snapshot, not full kernel or all-principal privacy proof";
        public string decision = "indeterminate: explicit trust policy and continuing custody are required";
        public List<string> errors = new List<string>();
    }
    [StructLayout(LayoutKind.Sequential)] internal struct FileInfo {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Mapping { public uint Read, Write, Execute, All; }
    [StructLayout(LayoutKind.Sequential)] internal struct Luid { public uint Low; public int High; }
    internal static class Native {
        [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
        internal static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfo info);
        [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetVolumeInformationByHandleW(IntPtr handle, StringBuilder name, uint size, out uint serial, out uint maxComponent, out uint flags, StringBuilder fs, uint fsSize);
        [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentThread();
        [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
        [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, uint length, out uint needed);
        [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);
        [DllImport("advapi32.dll")] internal static extern uint GetSecurityInfo(IntPtr handle, int type, uint sections, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")] internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AccessCheck(IntPtr descriptor, IntPtr token, uint desired, ref Mapping mapping, IntPtr privileges, ref uint size, out uint granted, [MarshalAs(UnmanagedType.Bool)] out bool status);
    }
    public static class Observer {
        const int MaxNodes = 24, MaxGroups = 128, MaxPrivileges = 64, MaxBuffer = 16384;
        static void Require(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
        static void Win(bool value, string operation) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
        static void Error(Result result,string error) { result.errorCount++; if(result.errors.Count<8)result.errors.Add(error.Length>256?error.Substring(0,256):error); }
        static void Budget(Stopwatch watch) { Require(watch.ElapsedMilliseconds < 5000, "Native metadata admission budget exceeded; no retry"); }
        // Windows x64 contracts only. Fixed structures never use a null sizing probe.
        internal sealed class TokenLayout {
            internal readonly uint Fixed, Minimum;
            internal TokenLayout(uint fixedBytes,uint minimum) { Fixed=fixedBytes;Minimum=minimum; }
        }
        internal static TokenLayout Layout(int kind) {
            switch(kind) {
                case 1: return new TokenLayout(0,16); // TOKEN_USER + SID
                case 2: return new TokenLayout(0,4); // TOKEN_GROUPS; empty count needs no array
                case 3: return new TokenLayout(0,4); // TOKEN_PRIVILEGES
                case 4: return new TokenLayout(0,8); // TOKEN_OWNER + SID
                case 5: return new TokenLayout(0,8); // TOKEN_PRIMARY_GROUP + SID
                case 6: return new TokenLayout(0,8); // TOKEN_DEFAULT_DACL; null PACL is valid
                case 8: return new TokenLayout(4,4); // TOKEN_TYPE
                case 9: return new TokenLayout(4,4); // SECURITY_IMPERSONATION_LEVEL
                case 10: return new TokenLayout(56,56); // TOKEN_STATISTICS; ModifiedId offset48
                case 11: return new TokenLayout(0,4); // TOKEN_GROUPS restricting SIDs
                case 24: return new TokenLayout(4,4); // DWORD TokenVirtualizationEnabled
                case 25: return new TokenLayout(0,16); // TOKEN_MANDATORY_LABEL + SID
                case 29: return new TokenLayout(4,4); // DWORD TokenIsAppContainer
                case 33: return new TokenLayout(0,16); // CLAIM_SECURITY_ATTRIBUTES_INFORMATION
                case 34: return new TokenLayout(0,16); // CLAIM_SECURITY_ATTRIBUTES_INFORMATION
                case 37: return new TokenLayout(0,4); // TOKEN_GROUPS device groups
                case 38: return new TokenLayout(0,4); // TOKEN_GROUPS restricted device groups
                default: throw new InvalidOperationException("Unreviewed token class; no query: "+kind);
            }
        }
        static string QueryState(int kind,string phase,bool ok,int error,uint capacity,uint returned) {
            return "GetTokenInformation kind="+kind+" phase="+phase+" ok="+(ok?"1":"0")+" capacity="+capacity+" returned="+returned+" win32="+(ok?"n/a":error.ToString(System.Globalization.CultureInfo.InvariantCulture))+"; no retry";
        }
        internal struct TokenReply { internal bool Ok; internal uint Returned; internal int Error; }
        internal delegate TokenReply TokenRead(IntPtr token,int kind,IntPtr memory,uint capacity);
        static TokenReply ReadNativeToken(IntPtr token,int kind,IntPtr memory,uint capacity) {
            uint actual=0; bool ok=Native.GetTokenInformation(token,kind,memory,capacity,out actual);
            int error=ok?0:Marshal.GetLastWin32Error(); // Capture only on BOOL failure, before any other call.
            return new TokenReply { Ok=ok,Returned=actual,Error=error };
        }
        static T TokenValue<T>(IntPtr token,int kind,Func<IntPtr,uint,T> read) {
            return QueryToken(token,kind,read,ReadNativeToken,Marshal.AllocHGlobal,Marshal.FreeHGlobal);
        }
        // Per-call internal seams for compiled deterministic tests; no global hook or production selector.
        internal static T QueryToken<T>(IntPtr token,int kind,Func<IntPtr,uint,T> read,TokenRead query,Func<int,IntPtr> allocate,Action<IntPtr> release) {
            TokenLayout layout=Layout(kind); uint capacity=layout.Fixed==0?(uint)MaxBuffer:layout.Fixed;
            IntPtr memory=allocate((int)capacity);
            try {
                Require(memory!=IntPtr.Zero,"Missing token buffer");
                TokenReply reply=query(token,kind,memory,capacity);uint actual=reply.Returned;
                Require(reply.Ok && actual>=layout.Minimum && actual<=capacity && (layout.Fixed==0 || actual==layout.Fixed),QueryState(kind,layout.Fixed==0?"bounded":"fixed",reply.Ok,reply.Error,capacity,actual));
                return read(memory,actual); // No decoder can see a failed or short reply.
            } finally { release(memory); }
        }
        internal static bool SupportedToken(uint type,uint? level) {
            return type==1?level==null:type==2 && (level==2 || level==3);
        }
        internal static void ValidateTokenContext(TokenFacts context) {
            Require(context.virtualizationEnabled==0,"Virtualized token profile unsupported");
            Require(context.isAppContainer==0,"AppContainer profile is unsupported; no guessed access result");
        }
        internal static void ValidateContextCounts(uint[] counts) {
            Require(counts!=null && counts.Length==4,"Missing documented context counts");
            foreach(uint count in counts)Require(count==0,"Claims/device context unsupported; values withheld");
        }
        static void Within(IntPtr buffer,uint length,IntPtr value,uint bytes,uint minimumOffset,string what) {
            ulong start=unchecked((ulong)buffer.ToInt64()),at=unchecked((ulong)value.ToInt64());
            Require(length>=bytes && at>=start && at-start>=minimumOffset && at-start<=length-bytes,what+" outside returned token buffer");
        }
        static string Sid(IntPtr buffer,uint length,IntPtr value,uint minimumOffset) {
            Within(buffer,length,value,8,minimumOffset,"SID header");
            int count=Marshal.ReadByte(value,1);Require(Marshal.ReadByte(value)==1 && count<=15,"SID revision/subauthority bound");
            uint bytes=(uint)(8+count*4);Within(buffer,length,value,bytes,minimumOffset,"SID body");
            byte[] copy=new byte[bytes];Marshal.Copy(value,copy,0,(int)bytes);return new SecurityIdentifier(copy,0).Value;
        }
        static string PointerSid(IntPtr token,int kind) {
            return TokenValue(token,kind,(p,n)=> {uint header=kind==1 || kind==25?16u:8u;return Sid(p,n,Marshal.ReadIntPtr(p),header);});
        }
        static uint Scalar(IntPtr token,int kind) {
            return ScalarWithReply(token,kind,ReadNativeToken,Marshal.AllocHGlobal,Marshal.FreeHGlobal);
        }
        internal static uint ScalarWithReply(IntPtr token,int kind,TokenRead query,Func<int,IntPtr> allocate,Action<IntPtr> release) {
            Require(Layout(kind).Fixed==4,"Not a retained four-byte scalar");
            return QueryToken(token,kind,(p,n)=>unchecked((uint)Marshal.ReadInt32(p)),query,allocate,release);
        }
        static SidAttributes[] Groups(IntPtr token, int kind) {
            return TokenValue(token, kind, (p,n) => {
                Require(n >= 4, "Group count bound"); int count = Marshal.ReadInt32(p); Require(count >= 0 && count <= MaxGroups && (count == 0 || 8L + count * 16L <= n), "Group array bound");
                SidAttributes[] rows = new SidAttributes[count];
                for (int i=0;i<count;i++) { IntPtr row = IntPtr.Add(p,8+i*16); rows[i] = new SidAttributes { sid=Sid(p,n,Marshal.ReadIntPtr(row),(uint)(8+count*16)), attributes=unchecked((uint)Marshal.ReadInt32(row,8)) }; }
                return rows;
            });
        }
        static long Modified(IntPtr token) { return TokenValue(token,10,(p,n) => { Require(n >= 56,"Token statistics bound"); return Marshal.ReadInt64(p,48); }); }
        static PrivilegeFact[] Privileges(IntPtr token) {
            string[] names = { "SeBackupPrivilege", "SeRestorePrivilege", "SeTakeOwnershipPrivilege", "SeSecurityPrivilege", "SeChangeNotifyPrivilege" };
            return TokenValue(token,3,(p,n) => {
                Require(n >= 4,"Privilege count bound"); int count=Marshal.ReadInt32(p); Require(count>=0 && count<=MaxPrivileges && 4L+12L*count<=n,"Privilege array bound");
                List<PrivilegeFact> rows=new List<PrivilegeFact>();
                foreach(string name in names) {
                    Luid id; Win(Native.LookupPrivilegeValueW(null,name,out id),"LookupPrivilegeValue"); PrivilegeFact fact=new PrivilegeFact { name=name };
                    for(int i=0;i<count;i++) { int at=4+i*12; if(unchecked((uint)Marshal.ReadInt32(p,at))==id.Low && Marshal.ReadInt32(p,at+4)==id.High) { fact.present=true; fact.attributes=unchecked((uint)Marshal.ReadInt32(p,at+8)); } }
                    rows.Add(fact);
                }
                return rows.ToArray();
            });
        }
        static string DefaultDacl(IntPtr token,string owner,string group) {
            return TokenValue(token,6,(p,n)=> {
                Require(n>=8,"Default DACL pointer bound"); IntPtr acl=Marshal.ReadIntPtr(p); if(acl==IntPtr.Zero)return null;
                Within(p,n,acl,8,8,"Default DACL header");
                int length=(ushort)Marshal.ReadInt16(acl,2);Require(length>=8 && length<=MaxBuffer,"Default DACL length bound");Within(p,n,acl,(uint)length,8,"Default DACL body");
                byte[] bytes=new byte[length];Marshal.Copy(acl,bytes,0,length);RawAcl raw=new RawAcl(bytes,0);Require(raw.Count<=128,"Default DACL ACE bound");
                foreach(GenericAce ace in raw)Require(ace.AceType==AceType.AccessAllowed || ace.AceType==AceType.AccessDenied,"Default DACL unsupported; values withheld");
                return new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent,new SecurityIdentifier(owner),new SecurityIdentifier(group),null,raw).GetSddlForm(AccessControlSections.Access);
            });
        }
        static FileInfo Identity(IntPtr handle) { FileInfo info; Win(Native.GetFileInformationByHandle(handle,out info),"GetFileInformationByHandle"); Require((info.Attributes & 16)!=0 && (info.Attributes & 1024)==0,"Not a physical directory / reparse point"); return info; }
        static string FileId(FileInfo info) { return (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString(System.Globalization.CultureInfo.InvariantCulture); }
        static byte[] Descriptor(IntPtr handle) {
            IntPtr owner,group,dacl,sacl,sd=IntPtr.Zero;
            uint code=Native.GetSecurityInfo(handle,1,0x77,out owner,out group,out dacl,out sacl,out sd);
            try { if(code!=0) throw new Win32Exception((int)code,"GetSecurityInfo owner/group/DACL/label/resource-policy presence"); uint size=Native.GetSecurityDescriptorLength(sd); Require(size>0 && size<=MaxBuffer,"Descriptor bound"); byte[] bytes=new byte[size]; Marshal.Copy(sd,bytes,0,(int)size); return bytes; }
            finally { if(sd!=IntPtr.Zero) Require(Native.LocalFree(sd)==IntPtr.Zero,"Descriptor memory release failed"); }
        }
        static bool Equal(byte[] a,byte[] b) { if(a.Length!=b.Length)return false; for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true; }
        static IntPtr Open(string path) {
            IntPtr handle=Native.CreateFileW("\\\\?\\"+path,0x20080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
            if(handle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Open existing directory without delete sharing"); return handle;
        }
        public static Result Inspect(string[] paths,string[] volumes,string[] files) {
            Result result=new Result(); List<IntPtr> directories=new List<IntPtr>(); IntPtr token=IntPtr.Zero,duplicate=IntPtr.Zero; Stopwatch watch=Stopwatch.StartNew();
            List<NodeFact> facts=new List<NodeFact>(); List<byte[]> descriptors=new List<byte[]>(); bool closed=true;
            try {
                Require(Environment.OSVersion.Platform==PlatformID.Win32NT && IntPtr.Size==8,"Windows x64 required");
                Require(paths!=null && paths.Length>0 && paths.Length<=MaxNodes && volumes!=null && files!=null && volumes.Length==paths.Length && files.Length==paths.Length,"Fixed ancestor closure bound");
                // Query/duplicate only the actual calling token; never use a linked or elevated token.
                string source="thread";
                if(!Native.OpenThreadToken(Native.GetCurrentThread(),0xA,true,out token)) {
                    int code=Marshal.GetLastWin32Error(); Require(code==1008,"Thread token query failed; no identity fallback"); source="process";
                    Win(Native.OpenProcessToken(Native.GetCurrentProcess(),0xA,out token),"OpenProcessToken");
                }
                long modified=Modified(token); uint tokenType=Scalar(token,8);uint? level=tokenType==2?(uint?)Scalar(token,9):null; Require(SupportedToken(tokenType,level),"Unsupported token type/impersonation level");
                Win(Native.DuplicateToken(token,2,out duplicate),"DuplicateToken for AccessCheck only");
                TokenFacts context=new TokenFacts { source=source,tokenType=tokenType,impersonationLevel=level,userAttributes=TokenValue(token,1,(p,n)=>{Require(n>=16,"User attributes bound");return unchecked((uint)Marshal.ReadInt32(p,8));}),user=PointerSid(token,1),owner=PointerSid(token,4),primaryGroup=PointerSid(token,5),groups=Groups(token,2),restrictedSids=Groups(token,11),integrity=PointerSid(token,25),isAppContainer=Scalar(token,29),relevantPrivileges=Privileges(token) };
                context.defaultDaclSddl=DefaultDacl(token,context.owner,context.primaryGroup);context.virtualizationEnabled=Scalar(token,24);result.token=context;ValidateTokenContext(context);
                // Documented claim/device counts only. Reserved classes35/36/39 are not queried.
                // Their absence is not certified; no claim values/device identity lists are exported.
                int[] kinds={33,34,37,38}; uint[] counts=new uint[kinds.Length];
                for(int c=0;c<kinds.Length;c++) { Budget(watch); int kind=kinds[c]; counts[c]=TokenValue(token,kind,(p,n)=>{Require(n>=(kind==37 || kind==38?4:16),"Claim/device context count bound");return unchecked((uint)Marshal.ReadInt32(p,kind==37 || kind==38?0:4));}); }
                context.unsupportedContextCounts=counts;result.tokenProjectionComplete=true;
                ValidateContextCounts(counts);
                // Caller supplies a fixed, unique root-to-leaf closure with pre-observed object IDs.
                HashSet<string> seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase); int totalDescriptorBytes=0;
                for(int i=0;i<paths.Length;i++) {
                    Budget(watch); string path=paths[i];
                    Require(path!=null && path.Length<=4096 && path.Length>=3 && char.IsLetter(path[0]) && path[1]==':' && path[2]=='\\' && path.IndexOf(':',2)<0 && path.IndexOf('\0')<0 && Path.GetFullPath(path)==path && seen.Add(path),"Invalid/local path boundary");
                    string parent=Path.GetDirectoryName(path.TrimEnd('\\'));
                    if(path.Length>3)Require(parent!=null && seen.Contains(parent),"Ancestors must be acquired root-first");
                    IntPtr handle=Open(path); directories.Add(handle); FileInfo info=Identity(handle);
                    Require(info.Volume.ToString()==volumes[i] && FileId(info)==files[i] && files[i]!="0","Pre-observed directory identity changed");
                    StringBuilder fs=new StringBuilder(32);uint serial,max,flags;
                    Win(Native.GetVolumeInformationByHandleW(handle,null,0,out serial,out max,out flags,fs,32),"GetVolumeInformationByHandle");
                    Require(fs.ToString()=="NTFS" && serial==info.Volume,"Only local NTFS profile is supported");
                    byte[] bytes=Descriptor(handle); totalDescriptorBytes+=bytes.Length;Require(totalDescriptorBytes<=32768,"Aggregate descriptor bound");
                    RawSecurityDescriptor raw=new RawSecurityDescriptor(bytes,0); Require(raw.Owner!=null && raw.Group!=null,"Descriptor owner/group missing");
                    List<int> unsupported=new List<int>(); List<AceFact> aceFacts=new List<AceFact>(); if(raw.DiscretionaryAcl!=null) {
                        Require(raw.DiscretionaryAcl.Count<=128,"DACL ACE bound"); foreach(GenericAce ace in raw.DiscretionaryAcl) { KnownAce known=ace as KnownAce; aceFacts.Add(new AceFact { type=(int)ace.AceType,flags=(int)ace.AceFlags,sid=known==null?null:known.SecurityIdentifier.Value,mask=known==null?(long?)null:known.AccessMask }); if(ace.AceType!=AceType.AccessAllowed && ace.AceType!=AceType.AccessDenied) unsupported.Add((int)ace.AceType); }
                    }
                    List<int> unsupportedSacl=new List<int>(); if(raw.SystemAcl!=null) {
                        Require(raw.SystemAcl.Count<=128,"Label/policy ACE bound");
                        foreach(GenericAce ace in raw.SystemAcl)if((int)ace.AceType!=17)unsupportedSacl.Add((int)ace.AceType);
                    }
                    // Label is retained in SDDL; AccessCheck below is not a MIC/kernel-open claim.
                    NodeFact fact=new NodeFact { path=path,volume=info.Volume.ToString(),fileId=FileId(info),fileSystem=fs.ToString(),sddl=(unsupported.Count==0 && unsupportedSacl.Count==0)?raw.GetSddlForm(AccessControlSections.All):"withheld: unsupported descriptor",daclPresent=(raw.ControlFlags & ControlFlags.DiscretionaryAclPresent)!=0,daclNull=raw.DiscretionaryAcl==null,aces=aceFacts.ToArray(),unsupportedAceTypes=unsupported.ToArray(),unsupportedSaclTypes=unsupportedSacl.ToArray() };
                    descriptors.Add(bytes);facts.Add(fact); Require(unsupported.Count==0 && unsupportedSacl.Count==0,"Conditional/object/CAP/resource/unknown descriptor: indeterminate, no simplified evaluation");
                }
                result.pinsHeldDuringSnapshot=true;
                for(int i=0;i<directories.Count;i++) {
                    Budget(watch); IntPtr memory=IntPtr.Zero,priv=IntPtr.Zero;
                    try {
                        memory=Marshal.AllocHGlobal(descriptors[i].Length);priv=Marshal.AllocHGlobal(1024);
                        Marshal.Copy(descriptors[i],0,memory,descriptors[i].Length); Mapping mapping=new Mapping { Read=0x120089,Write=0x120116,Execute=0x1200A0,All=0x1F01FF };
                        uint size=1024,granted;bool status;
                        Win(Native.AccessCheck(memory,duplicate,0x02000000,ref mapping,priv,ref size,out granted,out status),"AccessCheck MAXIMUM_ALLOWED");
                        Require(size>=8 && size<=1024 && Marshal.ReadInt32(priv)>=0 && Marshal.ReadInt32(priv)<=64,"AccessCheck privilege-set bound");facts[i].accessCheckSucceeded=true;facts[i].accessStatus=status;facts[i].grantedMaximum=granted;facts[i].privilegesUsed=Marshal.ReadInt32(priv);
                    } finally {if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);if(priv!=IntPtr.Zero)Marshal.FreeHGlobal(priv);}
                }
                // Pins stay held throughout both identity and descriptor rechecks. No retry on drift.
                for(int i=0;i<directories.Count;i++) {
                    Budget(watch); IntPtr reopened=Open(paths[i]);
                    try {FileInfo again=Identity(reopened);Require(again.Volume.ToString()==volumes[i] && FileId(again)==files[i],"Path rebound while observing");facts[i].identityRechecked=true;}
                    finally {if(!Native.CloseHandle(reopened)){closed=false;Error(result,"Recheck handle close unconfirmed");}}
                    Require(Equal(descriptors[i],Descriptor(directories[i])),"Security descriptor changed during snapshot");facts[i].descriptorRechecked=true;
                }
                Require(Modified(token)==modified,"Calling token changed during snapshot");result.tokenRechecked=true;result.snapshotConsistent=true;
            } catch(Exception error) {Error(result,error.GetType().Name+": "+error.Message);}
            finally {
                // Independent closes, no serialized handles/token bytes and no retry loop.
                for(int i=directories.Count-1;i>=0;i--)if(!Native.CloseHandle(directories[i])){closed=false;Error(result,"Directory handle close unconfirmed");}
                if(duplicate!=IntPtr.Zero && !Native.CloseHandle(duplicate)){closed=false;Error(result,"Duplicate token close unconfirmed");}
                if(token!=IntPtr.Zero && !Native.CloseHandle(token)){closed=false;Error(result,"Query token close unconfirmed");}
                result.handleClosureComplete=closed;result.nodes=facts.ToArray();
            }
            return result;
        }
    }
}
