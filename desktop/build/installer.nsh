; Custom NSIS include for the Bubbly installer.
;
; Adds an "Additional Options" page after the install-directory page so setup
; isn't just a chain of Next buttons. The user chooses which integrations they
; want, and NOTHING optional is installed unless it is ticked:
;
;   1. Desktop shortcut
;   2. Start Menu shortcut
;   3. "Open with Bubbly" — Explorer context menu on folders
;   4. Add Bubbly to PATH (so `bubbly` works in a terminal)
;
; Shortcut creation is handled here rather than by electron-builder's
; createDesktopShortcut/createStartMenuShortcut flags (both disabled in
; package.json) so the checkboxes are actually authoritative.
;
; Everything is registered under HKCU (per-user) so no elevation is needed.

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "nsDialogs.nsh"

Var BubblyDialog
Var BubblyCbDesktop
Var BubblyCbStartMenu
Var BubblyCbContext
Var BubblyCbPath
Var BubblyStateDesktop
Var BubblyStateStartMenu
Var BubblyStateContext
Var BubblyStatePath

; ---- Options page -----------------------------------------------------------

Function BubblyOptionsPageCreate
  !insertmacro MUI_HEADER_TEXT "Additional Options" "Choose how Bubbly integrates with Windows."

  nsDialogs::Create 1018
  Pop $BubblyDialog
  ${If} $BubblyDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0u 100% 20u "Select the optional integrations you want. You can change any of these later by re-running this installer."
  Pop $0

  ${NSD_CreateCheckbox} 0 26u 100% 12u "Create a &desktop shortcut"
  Pop $BubblyCbDesktop
  ${NSD_Check} $BubblyCbDesktop

  ${NSD_CreateCheckbox} 0 42u 100% 12u "Create a &Start Menu shortcut"
  Pop $BubblyCbStartMenu
  ${NSD_Check} $BubblyCbStartMenu

  ${NSD_CreateCheckbox} 0 58u 100% 12u 'Add "&Open with Bubbly" to the folder right-click menu'
  Pop $BubblyCbContext
  ${NSD_Check} $BubblyCbContext

  ${NSD_CreateCheckbox} 0 74u 100% 12u "Add Bubbly to my &PATH (run 'bubbly' from a terminal)"
  Pop $BubblyCbPath
  ; PATH changes are the most invasive, so this one is opt-IN.
  ${NSD_Uncheck} $BubblyCbPath

  ${NSD_CreateLabel} 0 94u 100% 20u "All options apply to the current user only, so Windows will not ask for administrator permission."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function BubblyOptionsPageLeave
  ${NSD_GetState} $BubblyCbDesktop $BubblyStateDesktop
  ${NSD_GetState} $BubblyCbStartMenu $BubblyStateStartMenu
  ${NSD_GetState} $BubblyCbContext $BubblyStateContext
  ${NSD_GetState} $BubblyCbPath $BubblyStatePath
FunctionEnd

; Insert the page right after the install-location page.
!macro customPageAfterChangeDir
  Page custom BubblyOptionsPageCreate BubblyOptionsPageLeave
!macroend

; ---- Apply the chosen integrations at install time ---------------------------

!macro customInstall
  ; --- Desktop shortcut ---
  ${If} $BubblyStateDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\Bubbly.lnk" "$INSTDIR\Bubbly.exe" "" "$INSTDIR\Bubbly.exe" 0
  ${EndIf}

  ; --- Start Menu shortcut ---
  ${If} $BubblyStateStartMenu == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\Bubbly.lnk" "$INSTDIR\Bubbly.exe" "" "$INSTDIR\Bubbly.exe" 0
  ${EndIf}

  ; --- "Open with Bubbly" folder context menu ---
  ${If} $BubblyStateContext == ${BST_CHECKED}
    ; On a folder itself...
    WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithBubbly" "" "Open with Bubbly"
    WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithBubbly" "Icon" "$INSTDIR\Bubbly.exe"
    WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithBubbly\command" "" '"$INSTDIR\Bubbly.exe" "%1"'
    ; ...and on the background of an open folder.
    WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithBubbly" "" "Open with Bubbly"
    WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithBubbly" "Icon" "$INSTDIR\Bubbly.exe"
    WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithBubbly\command" "" '"$INSTDIR\Bubbly.exe" "%V"'
  ${EndIf}

  ; --- PATH ---
  ${If} $BubblyStatePath == ${BST_CHECKED}
    ReadRegStr $0 HKCU "Environment" "Path"
    ${If} $0 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    ${Else}
      ; Only append when it isn't already present.
      ${StrContains} $1 "$INSTDIR" "$0"
      ${If} $1 == ""
        WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
      ${EndIf}
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

; ---- Remove everything we may have added ------------------------------------

!macro customUnInstall
  ; Shortcuts — Delete on a missing file is a harmless no-op.
  Delete "$DESKTOP\Bubbly.lnk"
  Delete "$SMPROGRAMS\Bubbly.lnk"

  ; Context menu entries
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenWithBubbly"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenWithBubbly"

  ; Remove from PATH
  ReadRegStr $0 HKCU "Environment" "Path"
  ${If} $0 != ""
    Push $0
    Push ";$INSTDIR"
    Call un.StrReplace
    Pop $0
    Push $0
    Push "$INSTDIR"
    Call un.StrReplace
    Pop $0
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

; ---- String replace function for uninstaller --------------------------------
Function un.StrReplace
  Exch $R1 ; substr
  Exch
  Exch $R2 ; string
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  StrLen $R3 $R1
  StrCpy $R4 ""
  StrCpy $R5 0
  rloop:
    StrCpy $R6 $R2 $R3 $R5
    ${If} $R6 == ""
      Goto rdone
    ${EndIf}
    ${If} $R6 == $R1
      IntOp $R5 $R5 + $R3
    ${Else}
      StrCpy $R6 $R2 1 $R5
      StrCpy $R4 "$R4$R6"
      IntOp $R5 $R5 + 1
    ${EndIf}
    Goto rloop
  rdone:
    StrCpy $R1 $R4
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Exch $R1
FunctionEnd
