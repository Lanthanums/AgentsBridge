using System;
using System.Runtime.InteropServices;
using System.Threading;
public class WindowInput {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
 [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
 static bool Down() { return (GetAsyncKeyState(1) & 0x8000) != 0; }
 public static void Main(string[] args) {
  if(args.Length!=4) return;
  SetProcessDPIAware();
  IntPtr window=new IntPtr(long.Parse(args[0]));
  if(!Down()) { Console.WriteLine("not-held"); return; }
  int startX=int.Parse(args[1]),startY=int.Parse(args[2]),threshold=int.Parse(args[3]);
  RECT bounds;GetWindowRect(window,out bounds);
  Console.WriteLine("held"); Console.Out.Flush();
  bool moved=false;int lastX=startX,lastY=startY,count=0;
  var elapsed=System.Diagnostics.Stopwatch.StartNew();
  timeBeginPeriod(1);
  try {
   while(Down() && IsWindow(window) && elapsed.ElapsedMilliseconds<120000) {
    POINT p;GetCursorPos(out p);int dx=p.X-startX,dy=p.Y-startY;
    if((moved || (long)dx*dx+(long)dy*dy>=threshold*threshold) && (p.X!=lastX || p.Y!=lastY)) {
     if(!moved) { moved=true; Console.WriteLine("moved");Console.Out.Flush(); }
     // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE: physical-pixel movement, no resize/IPC round trip.
     SetWindowPos(window,IntPtr.Zero,bounds.Left+dx,bounds.Top+dy,0,0,0x0015);
     lastX=p.X;lastY=p.Y;count++;
     if(count%32==0) { Console.WriteLine("stats "+count+" "+elapsed.ElapsedMilliseconds);Console.Out.Flush(); }
    }
    Thread.Sleep(4);
   }
  } finally { timeEndPeriod(1); }
  Console.WriteLine("stats "+count+" "+elapsed.ElapsedMilliseconds);
  Console.WriteLine("released");
 }
}
