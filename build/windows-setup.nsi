Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include WinVer.nsh
!include nsDialogs.nsh
!include "${ACTION_PRESENTATION}"

Name "Diagnostic Hub ${APP_VERSION}"
Caption "Diagnostic Hub Setup ${APP_VERSION}"
OutFile "${SETUP_OUT}"
InstallDir "$LOCALAPPDATA\Programs\DiagnosticHub"
RequestExecutionLevel user
CRCCheck on
SetCompressor /SOLID lzma
SetDatablockOptimize on
VIProductVersion "${FILE_VERSION}"
VIAddVersionKey "ProductName" "Diagnostic Hub Setup"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${FILE_VERSION}"
VIAddVersionKey "FileDescription" "Current-user Diagnostic Hub setup"
VIAddVersionKey "LegalCopyright" "Diagnostic Hub contributors"

Var HubRequest
Var HubResponse
Var HubOperation
Var HubToken
Var HubConsent
Var HubStartMenu
Var HubDesktop
Var HubLaunch
Var HubNoLaunch
Var HubResultText
Var HubLocationBox
Var HubActionBox
Var HubMenuBox
Var HubDesktopBox
Var HubLaunchBox
Var HubActionLabel
Var HubActionEffect
Var HubActionButton
Var HubActionEffectBox
Var HubReviewChoices
Var HubDialog

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "Install Diagnostic Hub for your current user.$\r$\n$\r$\nReview the application folder and shortcuts before any install change. Your settings and reports stay separate and are retained during repair or removal.$\r$\n$\r$\nThis build is unsigned; normal Windows publisher policies still apply."
!insertmacro MUI_PAGE_WELCOME
Page custom LocationCreate LocationLeave
Page custom OptionsCreate OptionsLeave
Page custom ReviewCreate ReviewLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "$HubResultText"
!insertmacro MUI_PAGE_FINISH
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Remove the owned Diagnostic Hub application from $INSTDIR?$\r$\n$\r$\nSettings and reports will be retained. Close that installation first."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE English

!macro WorkerFunctions PREFIX
Function ${PREFIX}ExtractWorker
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${PAYLOAD_DIR}\*"
  StrCpy $HubRequest "$PLUGINSDIR\setup-request.ini"
  StrCpy $HubResponse "$PLUGINSDIR\setup-response.ini"
FunctionEnd

Function ${PREFIX}CallWorker
  FileOpen $0 "$HubRequest" w
  FileWriteUTF16LE /BOM $0 "[setup]$\r$\n"
  FileClose $0
  WriteINIStr "$HubRequest" setup operation "$HubOperation"
  WriteINIStr "$HubRequest" setup root "$INSTDIR"
  WriteINIStr "$HubRequest" setup token "$HubToken"
  WriteINIStr "$HubRequest" setup consent "$HubConsent"
  WriteINIStr "$HubRequest" setup startMenu "$HubStartMenu"
  WriteINIStr "$HubRequest" setup desktop "$HubDesktop"
  WriteINIStr "$HubRequest" setup launch "$HubLaunch"
  WriteINIStr "$HubRequest" setup uninstaller "$PLUGINSDIR\Uninstall Diagnostic Hub.exe"
  System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
  ExecWait '$\"$PLUGINSDIR\payload\Diagnostic Hub.exe$\" --diagnostic-hub-setup-worker --request=$\"$HubRequest$\" --response=$\"$HubResponse$\"' $0
  ReadINIStr $1 "$HubResponse" setup ok
  ReadINIStr $HubResultText "$HubResponse" setup message
  ${If} $0 != 0
  ${OrIf} $1 != "1"
    ${If} $HubResultText == ""
      StrCpy $HubResultText "Setup could not verify this operation. The application and data have not been declared ready."
    ${EndIf}
    MessageBox MB_OK|MB_ICONSTOP "$HubResultText"
    StrCpy $0 "failed"
  ${Else}
    StrCpy $0 "ok"
  ${EndIf}
FunctionEnd
!macroend
!insertmacro WorkerFunctions ""
!insertmacro WorkerFunctions "un."

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Windows 10 or later is required."
    SetErrorLevel 64
    Quit
  ${EndIf}
  ReadEnvStr $0 PROCESSOR_ARCHITEW6432
  ${If} $0 == ""
    ReadEnvStr $0 PROCESSOR_ARCHITECTURE
  ${EndIf}
  ${If} $0 != "AMD64"
    MessageBox MB_OK|MB_ICONSTOP "This setup requires Windows x64."
    SetErrorLevel 64
    Quit
  ${EndIf}
  ${If} ${Silent}
    SetErrorLevel 64
    Quit
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
  StrCpy $HubConsent 0
  StrCpy $HubStartMenu 1
  StrCpy $HubDesktop 0
  StrCpy $HubLaunch 0
  StrCpy $HubNoLaunch 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/allusers" $1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Only current-user installation is available. Run without /allusers."
    SetErrorLevel 64
    Quit
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/NOLAUNCH" $1
  ${IfNot} ${Errors}
    StrCpy $HubNoLaunch 1
  ${EndIf}
  Call ExtractWorker
  WriteUninstaller "$PLUGINSDIR\Uninstall Diagnostic Hub.exe"
FunctionEnd

Function LocationCreate
  !insertmacro MUI_HEADER_TEXT "Application location" "Current user only; settings and reports stay separate"
  nsDialogs::Create 1018
  Pop $HubDialog
  ${NSD_CreateLabel} 0u 0u 290u 28u "Choose an empty folder within your user profile, or select an existing owned installation to launch, update or repair."
  Pop $0
  ${NSD_CreateDirRequest} 0u 36u 225u 14u "$INSTDIR"
  Pop $HubLocationBox
  ${NSD_CreateBrowseButton} 232u 36u 58u 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 BrowseLocation
  ${NSD_CreateLabel} 0u 64u 290u 32u "Setup will verify the selected location before enabling its maintenance choices. Protected, aliased or unowned nonempty folders are refused."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function BrowseLocation
  ${NSD_GetText} $HubLocationBox $0
  nsDialogs::SelectFolderDialog "Choose the application folder" "$0"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $HubLocationBox "$0"
  ${EndIf}
FunctionEnd

Function LocationLeave
  ${NSD_GetText} $HubLocationBox $INSTDIR
  StrCpy $HubOperation "probe"
  StrCpy $HubConsent 0
  StrCpy $HubLaunch 0
  Call CallWorker
  ${If} $0 != "ok"
    Abort
  ${EndIf}
  StrCpy $HubActionLabel ""
  ReadINIStr $HubToken "$HubResponse" setup reviewToken
  ReadINIStr $HubStartMenu "$HubResponse" setup startMenu
  ReadINIStr $HubDesktop "$HubResponse" setup desktop
FunctionEnd

Function OptionsCreate
  !insertmacro MUI_HEADER_TEXT "Options and maintenance" "$HubResultText"
  nsDialogs::Create 1018
  Pop $HubDialog
  ${NSD_CreateLabel} 0u 0u 290u 12u "Choose an action"
  Pop $0
  ${NSD_CreateDropList} 0u 16u 290u 13u ""
  Pop $HubActionBox
  !insertmacro HubAddActions
  ${If} $HubActionLabel == ""
  SendMessage $HubActionBox ${CB_SETCURSEL} 0 0
  ${Else}
    ${NSD_CB_SelectString} $HubActionBox "$HubActionLabel"
  ${EndIf}
  ${NSD_CreateLabel} 0u 36u 290u 25u ""
  Pop $HubActionEffectBox
  ${NSD_CreateCheckbox} 0u 64u 290u 12u "Create a Start menu shortcut (recommended)"
  Pop $HubMenuBox
  ${NSD_SetState} $HubMenuBox $HubStartMenu
  ${NSD_CreateCheckbox} 0u 80u 290u 12u "Create a desktop shortcut"
  Pop $HubDesktopBox
  ${NSD_SetState} $HubDesktopBox $HubDesktop
  ${NSD_CreateCheckbox} 0u 96u 290u 12u "Launch after install, update or repair"
  Pop $HubLaunchBox
  ${NSD_SetState} $HubLaunchBox $HubLaunch
  ${NSD_CreateLabel} 0u 116u 290u 18u "Settings and reports are retained. Setup does not migrate credentials, reconnect devices or change host security permissions."
  Pop $0
  ${NSD_OnChange} $HubActionBox OptionsActionChanged
  Call UpdateActionUI
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Next >"
  nsDialogs::Show
FunctionEnd

Function OptionsActionChanged
  Pop $0
  Call UpdateActionUI
FunctionEnd

Function UpdateActionUI
  ${NSD_GetText} $HubActionBox $HubActionLabel
  !insertmacro HubResolveAction
  !insertmacro HubDescribeAction
  ${NSD_SetText} $HubActionEffectBox "$HubActionEffect"
  ${If} $HubOperation == "install"
  ${OrIf} $HubOperation == "update"
  ${OrIf} $HubOperation == "repair"
    EnableWindow $HubMenuBox 1
    EnableWindow $HubDesktopBox 1
    ${If} $HubNoLaunch == 0
      EnableWindow $HubLaunchBox 1
    ${Else}
      EnableWindow $HubLaunchBox 0
    ${EndIf}
  ${Else}
    EnableWindow $HubMenuBox 0
    EnableWindow $HubDesktopBox 0
    EnableWindow $HubLaunchBox 0
  ${EndIf}
FunctionEnd

Function OptionsLeave
  Call UpdateActionUI
  ${NSD_GetState} $HubMenuBox $HubStartMenu
  ${NSD_GetState} $HubDesktopBox $HubDesktop
  ${NSD_GetState} $HubLaunchBox $HubLaunch
  ${If} $HubOperation == ""
    MessageBox MB_OK|MB_ICONSTOP "Choose an available action. A newer installed version may require its matching setup for repair."
    Abort
  ${EndIf}
FunctionEnd

Function ReviewCreate
  !insertmacro MUI_HEADER_TEXT "Review" "Confirm these choices before continuing"
  nsDialogs::Create 1018
  Pop $HubDialog
  !insertmacro HubDescribeAction
  ReadINIStr $1 "$HubResponse" setup candidateVersion
  ReadINIStr $2 "$HubResponse" setup installedVersion
  ReadINIStr $3 "$HubResponse" setup profile
  ${If} $2 == ""
    StrCpy $2 "None"
  ${EndIf}
  ${NSD_CreateLabel} 0u 0u 290u 10u "$HubActionLabel"
  Pop $0
  ${NSD_CreateLabel} 0u 12u 290u 10u "Setup version: $1    Installed version: $2"
  Pop $0
  ${NSD_CreateLabel} 0u 24u 290u 25u "$HubActionEffect"
  Pop $0
  ${NSD_CreateLabel} 0u 63u 290u 9u "Application folder (select or scroll to read the full path)"
  Pop $0
  nsDialogs::CreateControl "EDIT" ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_AUTOVSCROLL}|${ES_READONLY} ${WS_EX_CLIENTEDGE} 0u 73u 290u 24u "$INSTDIR"
  Pop $0
  ${NSD_CreateLabel} 0u 100u 290u 9u "Settings and reports folder (retained)"
  Pop $0
  nsDialogs::CreateControl "EDIT" ${DEFAULT_STYLES}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_AUTOVSCROLL}|${ES_READONLY} ${WS_EX_CLIENTEDGE} 0u 110u 290u 24u "$3"
  Pop $0
  StrCpy $HubReviewChoices "Shortcut and launch choices do not apply to this action."
  ${If} $HubOperation == "install"
  ${OrIf} $HubOperation == "update"
  ${OrIf} $HubOperation == "repair"
    StrCpy $1 "No"
    StrCpy $2 "No"
    StrCpy $3 "No"
    ${If} $HubStartMenu == 1
      StrCpy $1 "Yes"
    ${EndIf}
    ${If} $HubDesktop == 1
      StrCpy $2 "Yes"
    ${EndIf}
    ${If} $HubLaunch == 1
      StrCpy $3 "Yes"
    ${EndIf}
    StrCpy $HubReviewChoices "Start menu: $1    Desktop: $2    Launch: $3"
  ${EndIf}
  ${NSD_CreateLabel} 0u 50u 290u 10u "$HubReviewChoices"
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$HubActionButton"
  nsDialogs::Show
FunctionEnd

Function ReviewLeave
  StrCpy $HubConsent 1
FunctionEnd


Section "Apply reviewed operation"
  DetailPrint "Verifying the reviewed identity and complete package bytes..."
  Call CallWorker
  ${If} $0 != "ok"
    SetErrorLevel 1
    Abort
  ${EndIf}
  ReadINIStr $1 "$HubResponse" setup warnings
  StrCpy $HubResultText "$HubResultText$\r$\n$\r$\n$1$\r$\n$\r$\nApplication: $INSTDIR$\r$\nSettings and reports retained."
  DetailPrint "$HubResultText"
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  ${If} ${Silent}
    SetErrorLevel 64
    Quit
  ${EndIf}
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/ROOT=" $1
  ${IfNot} ${Errors}
    StrCpy $INSTDIR $1
  ${EndIf}
  StrCpy $HubConsent 0
  StrCpy $HubStartMenu 0
  StrCpy $HubDesktop 0
  StrCpy $HubLaunch 0
  Call un.ExtractWorker
  StrCpy $HubOperation "probe"
  Call un.CallWorker
  ${If} $0 != "ok"
    SetErrorLevel 1
    Quit
  ${EndIf}
  ReadINIStr $HubToken "$HubResponse" setup reviewToken
FunctionEnd

Section "Uninstall"
  StrCpy $HubOperation "remove"
  StrCpy $HubConsent 1
  DetailPrint "Checking owned files and active processes. Settings/reports will be retained..."
  Call un.CallWorker
  ${If} $0 != "ok"
    SetErrorLevel 1
    Abort
  ${EndIf}
  DetailPrint "$HubResultText"
SectionEnd
