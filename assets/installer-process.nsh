!macroundef FIND_PROCESS
!macro FIND_PROCESS _FILE _RETURN
  ${if} $IsPowerShellAvailable == 0
    # A single CimInstance has no Count property in Windows PowerShell.
    System::Call 'kernel32::SetEnvironmentVariableW(w "PELLO_INSTALLER_APP_EXE", w "$INSTDIR\${APP_EXECUTABLE_FILENAME}")'
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.ExecutablePath -eq $$env:PELLO_INSTALLER_APP_EXE}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    Push "find"
    Call ${PELLO_PROCESS_FUNCTION}
    Pop ${_RETURN}
  ${endif}
!macroend

!macroundef KILL_PROCESS
!macro KILL_PROCESS _FILE _FORCE
  Push $0
  ${if} ${_FORCE} == 1
    ${if} $IsPowerShellAvailable == 0
      StrCpy $0 "-Force"
    ${endif}
  ${else}
    StrCpy $0 ""
  ${endif}
  ${if} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariableW(w "PELLO_INSTALLER_APP_EXE", w "$INSTDIR\${APP_EXECUTABLE_FILENAME}")'
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.ExecutablePath -eq $$env:PELLO_INSTALLER_APP_EXE} | % { Stop-Process -Id $$_.ProcessId $0 }"`
  ${else}
    Push "kill"
    Call ${PELLO_PROCESS_FUNCTION}
  ${endif}
  Pop $0 # nsExec result
  Pop $0 # caller's register
!macroend
!include "${PROJECT_DIR}\assets\installer-process-fallback.nsh"
