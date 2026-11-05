import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
// ConPTY consumes unknown OSC on its input side. Inject the fixed capability
// reply as console key records, never through shell command text.
const REPLY_SCRIPT = String.raw`Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AwbConsoleInput {
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr sec,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] records,uint count,out uint written);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [StructLayout(LayoutKind.Explicit,CharSet=CharSet.Unicode,Size=20)] struct INPUT_RECORD {
  [FieldOffset(0)] public ushort EventType;
  [FieldOffset(4)] public int Down;
  [FieldOffset(8)] public ushort Repeat;
  [FieldOffset(10)] public ushort Key;
  [FieldOffset(12)] public ushort Scan;
  [FieldOffset(14)] public char Character;
  [FieldOffset(16)] public uint State;
 }
 public static void Send(int pid) {
  FreeConsole();
  if(!AttachConsole((uint)pid)) throw new Exception("AttachConsole: "+Marshal.GetLastWin32Error());
  IntPtr h=CreateFileW("CONIN$",0x40000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
  try {
   string text="\x1b]7501;?\x1b\\";
   var records=new INPUT_RECORD[text.Length];
   for(int i=0;i<text.Length;i++) records[i]=new INPUT_RECORD{EventType=1,Down=1,Repeat=1,Character=text[i]};
   uint written;
   if(!WriteConsoleInputW(h,records,(uint)records.Length,out written) || written != records.Length) throw new Exception("WriteConsoleInput: "+Marshal.GetLastWin32Error());
  } finally {CloseHandle(h);FreeConsole();}
 }
}
"@

`

export async function replyProgramStatus(pid: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid terminal process')
  const command = `$ErrorActionPreference='Stop'\n$expectedStart=[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks\n${REPLY_SCRIPT}\nif ([System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks -ne $expectedStart) { throw 'Terminal process changed' }\n[AwbConsoleInput]::Send(${pid})`
  await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000, signal })
}
