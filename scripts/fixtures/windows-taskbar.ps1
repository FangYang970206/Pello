param([Parameter(Mandatory = $true)][long]$WindowHandle, [string]$IconPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# Read the actual Shell property store; do not infer taskbar identity from JS.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  public static bool IconMatches(long window, int kind, string file) {
    IntPtr actual = SendMessage(new IntPtr(window), 127, new IntPtr(kind), IntPtr.Zero);
    if (actual == IntPtr.Zero || String.IsNullOrEmpty(file)) return false;
    using (Bitmap image = Icon.FromHandle(actual).ToBitmap()) {
      IntPtr expected = LoadImage(IntPtr.Zero, file, 1, image.Width, image.Height, 0x10);
      if (expected == IntPtr.Zero) return false;
      try {
        using (Bitmap reference = Icon.FromHandle(expected).ToBitmap()) {
          if (image.Size != reference.Size) return false;
          for (int y = 0; y < image.Height; y++) for (int x = 0; x < image.Width; x++)
            if (image.GetPixel(x, y).ToArgb() != reference.GetPixel(x, y).ToArgb()) return false;
          return true;
        }
      } finally { DestroyIcon(expected); }
    }
  }
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
  windowIconMatches = [WorkbenchTaskbar]::IconMatches($WindowHandle, 1, $IconPath)
  smallIconMatches = [WorkbenchTaskbar]::IconMatches($WindowHandle, 0, $IconPath)
} | ConvertTo-Json -Compress
