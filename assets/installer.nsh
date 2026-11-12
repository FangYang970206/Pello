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
