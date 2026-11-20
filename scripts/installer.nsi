Unicode true
!include "MUI2.nsh"
!include "${PAYLOAD_INCLUDE}"

Name "LingFlow"
OutFile "${SETUP_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\LingFlow"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LingFlow"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "LingFlow"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  ClearErrors
  !insertmacro InstallPayload
  IfErrors failed

  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\LingFlow.lnk" "$INSTDIR\LingFlow.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "LingFlow"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\LingFlow.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  IfErrors failed done
failed:
  SetErrorLevel 1
  Abort
done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetOutPath "$TEMP"
  ClearErrors
  !insertmacro RemovePayload
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\LingFlow.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir "$INSTDIR"
  Goto done
failed:
  SetErrorLevel 1
  Abort
done:
SectionEnd
