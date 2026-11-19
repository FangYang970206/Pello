# Native path matching when Windows PowerShell is unavailable. Filename-only
# taskkill could stop another installation with the same executable name.
!ifdef BUILD_UNINSTALLER
  !define PELLO_PROCESS_FUNCTION "un.PelloAppProcess"
!else
  !define PELLO_PROCESS_FUNCTION "PelloAppProcess"
!endif

Function ${PELLO_PROCESS_FUNCTION}
  Exch $R0 # find / kill
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  StrCpy $R8 1 # not found
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.R1'
  StrCmp $R1 -1 pello_process_return
  System::Alloc 556 # PROCESSENTRY32W in the 32-bit NSIS process
  Pop $R2
  System::Alloc 2048
  Pop $R5
  System::Call '*$R2(i 556)'
  System::Call 'kernel32::Process32FirstW(p R1, p R2) i.R6'
  pello_process_loop:
    StrCmp $R6 0 pello_process_done
    System::Call '*$R2(i, i, i.R3)'
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i R3) p.R4'
    StrCmp $R4 0 pello_process_next
    System::Call 'kernel32::QueryFullProcessImageNameW(p R4, i 0, p R5, *i 1024) i.R6'
    System::Call 'kernel32::CloseHandle(p R4)'
    StrCmp $R6 0 pello_process_next
    System::Call '*$R5(&w1024.R7)'
    StrCmp $R7 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 pello_process_next
    StrCpy $R8 0
    StrCmp $R0 "find" pello_process_done
    System::Call 'kernel32::OpenProcess(i 1, i 0, i R3) p.R4'
    StrCmp $R4 0 pello_process_next
    System::Call 'kernel32::TerminateProcess(p R4, i 0)'
    System::Call 'kernel32::CloseHandle(p R4)'
  pello_process_next:
    System::Call 'kernel32::Process32NextW(p R1, p R2) i.R6'
    Goto pello_process_loop
  pello_process_done:
    System::Free $R5
    System::Free $R2
    System::Call 'kernel32::CloseHandle(p R1)'
  pello_process_return:
    StrCpy $R0 $R8
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd
