param([Parameter(Mandatory = $true)][long]$WindowHandle)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# Read the actual Shell property store; do not infer taskbar identity from JS.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkbenchTaskbar {
  [StructLayout(LayoutKind.Sequential)] public struct Key { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr text;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Store {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out Key key);
    [PreserveSig] int GetValue(ref Key key, out Value value);
    [PreserveSig] int SetValue(ref Key key, ref Value value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out Store store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  public static string Read(long window, uint property) {
    Guid iid = typeof(Store).GUID;
    Store store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(window), ref iid, out store));
    try {
      Key key = new Key { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = property };
      Value value;
      Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
      try { return value.type == 31 ? Marshal.PtrToStringUni(value.text) : null; }
      finally { PropVariantClear(ref value); }
    } finally { Marshal.ReleaseComObject(store); }
  }
}
'@
[pscustomobject]@{
  appId = [WorkbenchTaskbar]::Read($WindowHandle, 5)
  relaunchCommand = [WorkbenchTaskbar]::Read($WindowHandle, 2)
  relaunchIcon = [WorkbenchTaskbar]::Read($WindowHandle, 3)
  relaunchDisplayName = [WorkbenchTaskbar]::Read($WindowHandle, 4)
  windowIcon = [WorkbenchTaskbar]::SendMessage([IntPtr]$WindowHandle, 127, [IntPtr]1, [IntPtr]::Zero).ToInt64().ToString()
} | ConvertTo-Json -Compress
