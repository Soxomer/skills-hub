; Never let installer process handling interrupt a filesystem operation.
!macro StopWorker
  ${If} ${FileExists} "$INSTDIR\ahm.exe"
    nsExec::ExecToStack '"$INSTDIR\ahm.exe" worker --stop --wait'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      SetErrorLevel 2
      Abort "Skills Hub is still finishing work. Wait and retry."
    ${EndIf}
  ${EndIf}
!macroend
!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopWorker
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopWorker
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Skills Hub Helper"
  ${EndIf}
!macroend
