# electron-builder 26.18 scans every process under INSTDIR, including this
# installer in data/updates and its uninstaller in data/tmp. Limit its existing
# close/retry flow to the application EXE. Pass paths through the environment
# so spaces, Unicode and apostrophes never become PowerShell source.
!macro customHeader
  !include "${PROJECT_DIR}\assets\installer-process.nsh"
  !ifndef BUILD_UNINSTALLER
    !tempfile PELLO_INSTALL_UTIL_DIR
    !system 'node "${PROJECT_DIR}\scripts\prepare-nsis-script.cjs" "${PELLO_INSTALL_UTIL_DIR}"' = 0
    # !include searches its working directory first. The generated utility
    # immediately restores the upstream directory for the remaining templates.
    !cd "${PELLO_INSTALL_UTIL_DIR}"
  !endif
!macroend

# Both upgrade and explicit uninstall must preserve the installation-local profile.
# Electron-builder writes "Uninstall Pello.exe" directly to $INSTDIR.
!macro customRemoveFiles
  SetOutPath $TEMP
  FindFirst $R0 $R1 "$INSTDIR\*"
  ${DoWhile} $R1 != ""
    ${If} $R1 != "."
    ${AndIf} $R1 != ".."
    ${AndIf} $R1 != "data"
    ${AndIf} $R1 != "pello.config.json"
      ${If} ${FileExists} "$INSTDIR\$R1\*"
        RMDir /r "$INSTDIR\$R1"
      ${Else}
        Delete "$INSTDIR\$R1"
      ${EndIf}
    ${EndIf}
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  RMDir "$INSTDIR"
!macroend
