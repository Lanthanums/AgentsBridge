param([long]$WindowHandle,[ValidateSet('Resize','Wheel','Sweep')][string]$Action,[int]$X,[int]$Y,[int]$DeltaX=-180,[int]$DeltaY=-150)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class InputRegressionQA {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int cx,int cy,uint flags);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 public static void Wheel(int delta) { mouse_event(0x0800,0,0,unchecked((uint)delta),UIntPtr.Zero); }
}
"@
[InputRegressionQA]::SetProcessDPIAware() | Out-Null
if($Action -eq 'Resize') {
 $rect=New-Object InputRegressionQA+RECT
 [InputRegressionQA]::GetWindowRect([IntPtr]$WindowHandle,[ref]$rect) | Out-Null
 [InputRegressionQA]::SendMessage([IntPtr]$WindowHandle,0x0231,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
 [InputRegressionQA]::SetWindowPos([IntPtr]$WindowHandle,[IntPtr]::Zero,$rect.Left,$rect.Top,$rect.Right-$rect.Left+$DeltaX,$rect.Bottom-$rect.Top+$DeltaY,0x0014) | Out-Null
 [InputRegressionQA]::SendMessage([IntPtr]$WindowHandle,0x0232,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
} elseif ($Action -eq 'Sweep') {
 for($i=1;$i -le 120;$i++) {
  [InputRegressionQA]::SetCursorPos($X+[int]($DeltaX*$i/120),$Y+[int]($DeltaY*$i/120)) | Out-Null
  [Threading.Thread]::Sleep(4)
 }
} else {
 [InputRegressionQA]::SetCursorPos($X,$Y) | Out-Null
 [Threading.Thread]::Sleep(80)
 for($i=0;$i -lt 3;$i++) { [InputRegressionQA]::Wheel($DeltaY); [Threading.Thread]::Sleep(35) }
}
