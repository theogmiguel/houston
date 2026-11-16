; The Tauri updater starts the downloaded installer with /P /UPDATE /R /ARGS and
; expects it to relaunch the app. Houston owns that relaunch so the /ARGS payload
; reaches the new process; electron-builder's own start is suppressed here and
; still honours --force-run from electron-updater.
!ifdef RUN_AFTER_FINISH
  !undef RUN_AFTER_FINISH
!endif

Var /GLOBAL houstonUpdateMode
Var /GLOBAL houstonRestart
Var /GLOBAL houstonLaunchArgs

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif

  ; A Tauri install registers its uninstaller under the product name; remove that
  ; entry so Add/Remove Programs lists only the Electron uninstaller. The guard
  ; keeps an unrelated entry that merely shares the folder name.
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Houston" "DisplayName"
  ${If} $R0 == "Houston"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Houston"
  ${EndIf}

  ; A silent install stays silent unless the caller asked for a relaunch. Any
  ; other install starts the app, as electron-builder's run-after-finish would.
  ${If} ${isForceRun}
    ; electron-builder starts it with --updated.
  ${ElseIf} $houstonRestart == "1"
    StrCpy $R0 "$houstonLaunchArgs"
    ${If} $R0 == ""
    ${AndIf} $houstonUpdateMode == "1"
      StrCpy $R0 "--updated"
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $1 "$launchLink" "open" "$R0"
  ${ElseIfNot} ${Silent}
    StrCpy $R0 "$houstonLaunchArgs"
    ${If} $R0 == ""
    ${AndIf} $houstonUpdateMode == "1"
      StrCpy $R0 "--updated"
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $1 "$launchLink" "open" "$R0"
  ${EndIf}
!macroend

; Install beside an existing per-user Houston install so the files replace it.
; Tauri's NSIS installer uses the same $LOCALAPPDATA\Houston directory.
!macro customInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Houston"
  StrCpy $houstonUpdateMode "0"
  StrCpy $houstonRestart "0"
  StrCpy $houstonLaunchArgs ""

  ; Tauri's updater passes its mode and relaunch arguments on this command line.
  ${GetParameters} $R0
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    StrCpy $houstonUpdateMode "1"
  ${EndIf}
  ${GetOptions} $R0 "/R" $R1
  ${IfNot} ${Errors}
    StrCpy $houstonRestart "1"
  ${EndIf}
  ${GetOptions} $R0 "/ARGS" $R1
  ${IfNot} ${Errors}
    StrCpy $houstonLaunchArgs "$R1"
  ${EndIf}

  ; electron-updater uses its own spellings for the same two decisions.
  ${StdUtils.TestParameter} $R1 "updated"
  ${If} $R1 == "true"
    StrCpy $houstonUpdateMode "1"
  ${EndIf}
  ${StdUtils.TestParameter} $R1 "force-run"
  ${If} $R1 == "true"
    StrCpy $houstonRestart "1"
  ${EndIf}
!macroend

; Stop the Houston 1 daemon by the pid its channel state records. Matching by
; image name would also hit the other channel's daemon.
!macro customUnInstall
  ClearErrors
  FileOpen $R0 "$APPDATA\..\..\.houston\daemon.json" r
  IfErrors houstonUninstallDone

  StrCpy $R1 ""
houstonUninstallReadLoop:
  FileRead $R0 $R2 1024
  IfErrors houstonUninstallReadEnd
  StrCpy $R3 0
houstonUninstallScanLine:
  StrCpy $R4 $R2 5 $R3
  StrCmp $R4 '"pid"' houstonUninstallFoundPid
  IntOp $R3 $R3 + 1
  StrLen $R5 $R2
  IntCmp $R3 $R5 houstonUninstallReadLoop houstonUninstallScanLine houstonUninstallReadLoop
houstonUninstallFoundPid:
  IntOp $R3 $R3 + 5
houstonUninstallSkipSeparator:
  StrCpy $R4 $R2 1 $R3
  StrCmp $R4 ' ' houstonUninstallNextSeparator
  StrCmp $R4 ':' houstonUninstallNextSeparator houstonUninstallParsePid
houstonUninstallNextSeparator:
  IntOp $R3 $R3 + 1
  Goto houstonUninstallSkipSeparator
houstonUninstallParsePid:
  StrCpy $R4 $R2 1 $R3
  StrCmp $R4 '' houstonUninstallReadEnd
  StrCmp $R4 ',' houstonUninstallReadEnd
  StrCmp $R4 '}' houstonUninstallReadEnd
  StrCmp $R4 '$\r' houstonUninstallReadEnd
  StrCmp $R4 '$\n' houstonUninstallReadEnd
  StrCpy $R1 "$R1$R4"
  IntOp $R3 $R3 + 1
  Goto houstonUninstallParsePid
houstonUninstallReadEnd:
  FileClose $R0

  ; Only a positive integer reaches the command line below.
  IntOp $R1 $R1 + 0
  IntCmp $R1 0 houstonUninstallDone houstonUninstallDone
  nsExec::ExecToLog `"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$p = Get-Process -Id $R1 -ErrorAction SilentlyContinue; if ($$p -and $$p.Path.StartsWith('$INSTDIR')) { Stop-Process -Id $R1 -Force }"`

houstonUninstallDone:
!macroend
