using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
// Own each CLI and ALL descendants in a Windows Job Object. Parent exit or forced
// termination closes the only job handle and kills descendants, including detached tools.
class JobHost {
 [StructLayout(LayoutKind.Sequential)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong r,w,o,rb,wb,ob; }
 [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr pm,jm,peakp,peakj; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref LIMIT l,int size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 static string Quote(string s) { var b=new StringBuilder("\""); int slashes=0; foreach(char c in s) { if(c=='\\'){slashes++;continue;} if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);} else {b.Append('\\',slashes);b.Append(c);} slashes=0; } b.Append('\\',slashes*2);return b.Append('"').ToString(); }
 static int Main(string[] args) {
  if(args.Length==0)return 64; IntPtr job=CreateJobObject(IntPtr.Zero,null);var limits=new LIMIT();limits.basic.flags=0x2000;
  if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT))))return 70;
  int ownerPid; if(!Int32.TryParse(Environment.GetEnvironmentVariable("AGENTSBRIDGE_PARENT_PID"),out ownerPid))return 74;
  IntPtr owner=OpenProcess(0x00100000,false,ownerPid);if(owner==IntPtr.Zero){CloseHandle(job);return 75;}
  ThreadPool.QueueUserWorkItem(delegate {WaitForSingleObject(owner,0xffffffff);Environment.Exit(73);});
  var si=new SI();si.cb=Marshal.SizeOf(typeof(SI));si.flags=0x100;si.input=GetStdHandle(-10);si.output=GetStdHandle(-11);si.error=GetStdHandle(-12);
  var line=new StringBuilder();foreach(string arg in args) {if(line.Length>0)line.Append(' ');line.Append(Quote(arg));}
  PI pi; if(!CreateProcess(args[0],line,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,Environment.CurrentDirectory,ref si,out pi)){Console.Error.WriteLine("CreateProcess: "+Marshal.GetLastWin32Error());CloseHandle(job);return 71;}
  if(!AssignProcessToJobObject(job,pi.process)){Console.Error.WriteLine("AssignProcessToJobObject: "+Marshal.GetLastWin32Error());TerminateProcess(pi.process,72);CloseHandle(job);return 72;}
  ResumeThread(pi.thread);CloseHandle(pi.thread);WaitForSingleObject(pi.process,0xffffffff);uint code;GetExitCodeProcess(pi.process,out code);CloseHandle(pi.process);CloseHandle(job);return unchecked((int)code);
 }
}
