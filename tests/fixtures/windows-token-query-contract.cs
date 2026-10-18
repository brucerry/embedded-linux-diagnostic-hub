// Compile WITH the exact production observer; no GetTokenInformation/AccessCheck/Inspect call occurs.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Reflection;
namespace HubOwnershipSnapshot.Tests {
    public sealed class ContractReport {
        public int schema=1, passed, failed;
        public string suite="reduced-token-v2-injected-replies";
        public bool compiledCSharpExecuted=true, windowsTokenApisCalled=false, directorySelected=false, admissionChanged=false;
        public List<string> errors=new List<string>();
    }
    public static class DeterministicTests {
        static void Check(bool ok,string reason) {if(!ok)throw new InvalidOperationException(reason);}
        sealed class Memory {
            internal int allocated,freed;
            readonly Dictionary<IntPtr,int> live=new Dictionary<IntPtr,int>();
            internal IntPtr Allocate(int size) {
                IntPtr p=Marshal.AllocHGlobal(size);live.Add(p,size);allocated++;
                byte[] poison=new byte[size];for(int i=0;i<size;i++)poison[i]=0xE7;Marshal.Copy(poison,0,p,size);return p;
            }
            internal void Release(IntPtr p) {Check(live.Remove(p),"missing/double free");Marshal.FreeHGlobal(p);freed++;}
            internal void Done(int count) {Check(allocated==count && freed==count && live.Count==0,"buffer ownership not released exactly once");}
        }
        static Observer.TokenReply Reply(bool ok,uint returned,int error) {return new Observer.TokenReply {Ok=ok,Returned=returned,Error=error};}
        static void Refuses(Action action,string part) {
            bool refused=false;
            try {action();} catch(InvalidOperationException e) {Check(e.Message.Contains(part),"wrong refusal: "+e.Message);refused=true;}
            Check(refused,"reply unexpectedly decoded/accepted");
        }
        static void Case(ContractReport report,string name,Action body) {
            try {body();report.passed++;}catch(Exception e){report.failed++;if(report.errors.Count<8){string text=name+": "+e.GetType().Name+": "+e.Message;report.errors.Add(text.Length>256?text.Substring(0,256):text);}}
        }
        public static ContractReport Run() {
            ContractReport report=new ContractReport();
            int[] kinds={1,2,3,4,5,6,8,9,10,11,24,25,29,33,34,37,38};
            int[] scalars={8,9,24,29};
            foreach(int value in kinds) {
                int kind=value;
                Case(report,"class "+kind+" single bounded C# query",delegate {
                    Memory memory=new Memory();int calls=0;Observer.TokenLayout layout=Observer.Layout(kind);
                    uint capacity=layout.Fixed==0?16384u:layout.Fixed;
                    uint answer=Observer.QueryToken(new IntPtr(123),kind,(p,n)=>n,delegate(IntPtr token,int actualKind,IntPtr p,uint actualCapacity) {
                        calls++;Check(token==new IntPtr(123) && actualKind==kind && actualCapacity==capacity,"wrong call boundary");return Reply(true,layout.Minimum,5); // Stale error MUST be ignored on success.
                    },memory.Allocate,memory.Release);
                    Check(answer==layout.Minimum && calls==1,"query count/extent");memory.Done(1);
                });
            }
            foreach(int value in scalars) {
                int kind=value;
                foreach(uint size in new uint[]{0,1,2,3,5,UInt32.MaxValue}) {
                    uint returned=size;
                    Case(report,"scalar "+kind+" refuses short/long poisoned reply "+returned,delegate {
                        Memory memory=new Memory();int calls=0;bool decoded=false;
                        Refuses(delegate {Observer.QueryToken(new IntPtr(123),kind,delegate(IntPtr p,uint n){decoded=true;return Marshal.ReadInt32(p);},delegate(IntPtr token,int k,IntPtr p,uint capacity){calls++;Marshal.WriteByte(p,0,1);return Reply(true,returned,5);},memory.Allocate,memory.Release);},"win32=n/a");
                        Check(!decoded && calls==1,"decoder/retry reached");memory.Done(1);
                        // Exercise the ACTUAL production scalar decoder route, not a JS model or alternate decoder.
                        Memory scalarMemory=new Memory();
                        Refuses(delegate {Observer.ScalarWithReply(new IntPtr(123),kind,delegate(IntPtr token,int k,IntPtr p,uint capacity){Marshal.WriteByte(p,0,1);return Reply(true,returned,5);},scalarMemory.Allocate,scalarMemory.Release);},"returned="+returned);
                        scalarMemory.Done(1);
                    });
                }
                Case(report,"scalar "+kind+" exact four bytes",delegate {
                    Memory memory=new Memory();
                    uint result=Observer.ScalarWithReply(new IntPtr(123),kind,delegate(IntPtr token,int k,IntPtr p,uint capacity){Check(capacity==4,"scalar capacity");Marshal.WriteInt32(p,unchecked((int)0x87654321));return Reply(true,4,87);},memory.Allocate,memory.Release);
                    Check(result==0x87654321,"wrong scalar decode");memory.Done(1);
                });
            }
            foreach(int value in new int[]{0,7,18,19,20,21,26,27,35,36,39,999}) {
                int kind=value;
                Case(report,"removed/unknown class "+kind,delegate {
                    Memory memory=new Memory();int calls=0;
                    Refuses(delegate {Observer.QueryToken(new IntPtr(123),kind,(p,n)=>n,delegate(IntPtr token,int k,IntPtr p,uint capacity){calls++;return Reply(true,4,0);},memory.Allocate,memory.Release);},"Unreviewed token class");
                    Check(calls==0,"unreviewed API call");memory.Done(0);
                });
            }
            Case(report,"native BOOL failure preserves numeric error without decode/retry",delegate {
                Memory memory=new Memory();int calls=0;bool decoded=false;
                Refuses(delegate {Observer.QueryToken(new IntPtr(123),24,delegate(IntPtr p,uint n){decoded=true;return n;},delegate(IntPtr token,int k,IntPtr p,uint capacity){calls++;return Reply(false,0,87);},memory.Allocate,memory.Release);},"kind=24 phase=fixed ok=0 capacity=4 returned=0 win32=87");
                Check(!decoded && calls==1,"failure decoded/retried");memory.Done(1);
            });
            Case(report,"decoder throw releases allocation",delegate {
                Memory memory=new Memory();
                Refuses(delegate {Observer.QueryToken<int>(new IntPtr(123),24,delegate(IntPtr p,uint n){throw new InvalidOperationException("decoder fault");},(token,k,p,capacity)=>Reply(true,4,0),memory.Allocate,memory.Release);},"decoder fault");memory.Done(1);
            });
            Case(report,"query throw releases allocation",delegate {
                Memory memory=new Memory();
                Refuses(delegate {Observer.QueryToken(new IntPtr(123),24,(p,n)=>n,delegate(IntPtr token,int k,IntPtr p,uint capacity){throw new InvalidOperationException("query fault");},memory.Allocate,memory.Release);},"query fault");memory.Done(1);
            });
            Case(report,"variable decoder sees only returned extent",delegate {
                Memory memory=new Memory();
                uint n=Observer.QueryToken(new IntPtr(123),33,(p,length)=>length,delegate(IntPtr token,int k,IntPtr p,uint capacity){Check(capacity==16384,"variable bound");return Reply(true,16,0);},memory.Allocate,memory.Release);Check(n==16,"tail exposed");memory.Done(1);
            });
            foreach(uint length in new uint[]{0,15,16385,UInt32.MaxValue}) {
                uint returned=length;
                Case(report,"variable malformed length "+returned,delegate {
                    Memory memory=new Memory();bool decoded=false;
                    Refuses(delegate {Observer.QueryToken(new IntPtr(123),33,delegate(IntPtr p,uint n){decoded=true;return n;},(token,k,p,capacity)=>Reply(true,returned,0),memory.Allocate,memory.Release);},"phase=bounded");Check(!decoded,"variable decoder reached");memory.Done(1);
                });
            }
            foreach(uint? value in new uint?[]{null,0,1,2,3,4,UInt32.MaxValue}) {
                uint? level=value;
                Case(report,"strict impersonation level "+level,delegate {Check(Observer.SupportedToken(2,level)==(level==2 || level==3),"invalid enum accepted");});
            }
            Case(report,"primary level is absent rather than fabricated zero",delegate {Check(Observer.SupportedToken(1,null),"primary missing level refused");Check(!Observer.SupportedToken(1,0) && !Observer.SupportedToken(1,2),"primary level fabricated");Check(!Observer.SupportedToken(0,null) && !Observer.SupportedToken(3,null),"unknown token type accepted");});
            Case(report,"AppContainer/virtualization guards",delegate {
                Observer.ValidateTokenContext(new TokenFacts {isAppContainer=0,virtualizationEnabled=0});
                Refuses(()=>Observer.ValidateTokenContext(new TokenFacts {isAppContainer=1}),"AppContainer");
                Refuses(()=>Observer.ValidateTokenContext(new TokenFacts {virtualizationEnabled=1}),"Virtualized");
            });
            Case(report,"claim/device guards",delegate {
                Observer.ValidateContextCounts(new uint[]{0,0,0,0});
                for(int i=0;i<4;i++){uint[] counts=new uint[4];counts[i]=1;Refuses(()=>Observer.ValidateContextCounts(counts),"Claims/device");}
                Refuses(()=>Observer.ValidateContextCounts(null),"Missing");
            });
            Case(report,"versioned DTO removes descriptive fields without defaults",delegate {
                Result result=new Result();Check(result.schema==2 && result.profile=="local-ntfs-reduced-token-snapshot-v2","old schema");
                foreach(string field in new string[]{"elevationType","elevated","hasRestrictions","uiAccess","mandatoryPolicy"})Check(typeof(TokenFacts).GetField(field)==null,"removed DTO field: "+field);
                Check(typeof(TokenFacts).GetField("impersonationLevel").FieldType==typeof(uint?),"primary absence not nullable");
                Check(result.token==null && !result.privatePathApproved && !result.admissionChanged,"fabricated token/approval");
            });
            return report;
        }
    }
}
