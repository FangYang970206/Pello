# Frozen customRemoveFiles shipped in v0.1.13-v0.1.15. The default process
# guard from electron-builder 26.18.1 is intentionally left in this fixture.
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
