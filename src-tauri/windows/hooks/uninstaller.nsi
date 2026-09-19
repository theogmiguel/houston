
; Uninstall stops the daemon by the pid recorded in the channel state dir's
; daemon.json -- never by image-name matching, which would also hit the other
; channel's daemon -- and only once that pid's image lives under $INSTDIR.
!macro NSIS_HOOK_POSTUNINSTALL
  ClearErrors
  FileOpen $0 "$APPDATA\..\..\.houston\daemon.json" r
  IfErrors done

  StrCpy $1 ""
readloop:
  FileRead $0 $2 1024
  IfErrors readend
  StrCpy $3 0
scanline:
  StrCpy $4 $2 5 $3
  StrCmp $4 '"pid"' foundpid
  IntOp $3 $3 + 1
  StrLen $5 $2
  IntCmp $3 $5 readloop readloop readloop
foundpid:
  IntOp $3 $3 + 5
chompws:
  StrCpy $4 $2 1 $3
  StrCmp $4 ' ' 0 parseint
  IntOp $3 $3 + 1
  Goto chompws
parseint:
  StrCpy $4 $2 1 $3
  StrCmp $4 '' readend
  StrCmp $4 ',' readend
  StrCmp $4 '}' readend
  StrCmp $4 '$\r' readend
  StrCmp $4 '$\n' readend
  StrCpy $1 "$1$4"
  IntOp $3 $3 + 1
  Goto parseint
readend:
  FileClose $0

  StrCmp $1 "" done
  nsExec::ExecToLog `"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-Process -Id $1 -ErrorAction SilentlyContinue; if ($p -and $p.Path.StartsWith('$INSTDIR')) { Stop-Process -Id $1 -Force }"`

done:
!macroend
