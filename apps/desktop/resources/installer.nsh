!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define HoustonStrRep '${UnStrRep}'
!else
  ${StrRep}
  !define HoustonStrRep '${StrRep}'
!endif

!macro customAppRunningMessages
  Push $0
  Push $1
  ${If} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "HOUSTON_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:HOUSTON_INSTALL_DIR } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath) } | Where-Object { $$_ -in 'Houston (Alpha)', 'Houston (Beta)', 'Houston (Nightly)' } | Select-Object -First 1 | ForEach-Object { [Console]::Write($$_) }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "HOUSTON_INSTALL_DIR", p 0)'
    ${If} $0 == 0
      ${If} $1 == "Houston (Alpha)"
      ${OrIf} $1 == "Houston (Beta)"
      ${OrIf} $1 == "Houston (Nightly)"
        ${HoustonStrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" $1
        ${HoustonStrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" $1
        ${HoustonStrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend

; Install beside an existing per-user Houston install so the files replace it.
!macro customInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Houston"
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
  IntCmp $R3 $R5 houstonUninstallReadLoop houstonUninstallReadLoop houstonUninstallReadLoop
houstonUninstallFoundPid:
  IntOp $R3 $R3 + 5
houstonUninstallChompWhitespace:
  StrCpy $R4 $R2 1 $R3
  StrCmp $R4 ' ' 0 houstonUninstallParsePid
  IntOp $R3 $R3 + 1
  Goto houstonUninstallChompWhitespace
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

  StrCmp $R1 "" houstonUninstallDone
  nsExec::ExecToLog `"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$p = Get-Process -Id $R1 -ErrorAction SilentlyContinue; if ($$p -and $$p.Path.StartsWith('$INSTDIR')) { Stop-Process -Id $R1 -Force }"`

houstonUninstallDone:
!macroend
