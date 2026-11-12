# -*- coding: utf-8 -*-
Unicode True
!include "MUI2.nsh"
!include "x64.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentSpaceNative"
Name "Agent Space Adapter"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Agent Space Adapter"
RequestExecutionLevel user
SetCompressor /SOLID lzma
AllowSkipFiles off
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Agent Space Adapter"
VIAddVersionKey "FileDescription" "Agent Space Adapter Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Agent Space contributors"

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\agent-space-native.exe"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString AdapterWriteFailed ${LANG_ENGLISH} "Could not replace Agent Space Adapter. Quit it from the system tray, then click Retry. If it is already closed, check that you can write to the installation folder."
LangString AdapterWriteFailed ${LANG_SIMPCHINESE} "无法更新 Agent 空间适配器。请从任务栏右下角的托盘菜单退出适配器，再点「重试」。如果适配器已退出，请检查安装目录的写入权限。"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "This installer requires 64-bit Windows." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
  SetRegView 64
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
retry_adapter:
  ClearErrors
  SetOverwrite try
  File "${PACKAGE_DIR}\agent-space-native.exe"
  SetOverwrite on
  IfErrors 0 adapter_written
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(AdapterWriteFailed)" /SD IDCANCEL IDRETRY retry_adapter
  SetErrorLevel 1
  Quit
adapter_written:
  File "${PACKAGE_DIR}\LICENSE"
  File "${PACKAGE_DIR}\README.txt"
  File "${PACKAGE_DIR}\THIRD-PARTY-NOTICES.txt"
  IfErrors in_use
!ifdef OFFICIAL_PLUGINS
  SetOutPath "$INSTDIR\official-plugins\codex"
  File "${PACKAGE_DIR}\official-plugins\codex\adapter.json"
  File "${PACKAGE_DIR}\official-plugins\codex\agent-space-adapter-codex.exe"
  File "${PACKAGE_DIR}\official-plugins\codex\LICENSE"
  File "${PACKAGE_DIR}\official-plugins\codex\THIRD-PARTY-NOTICES.txt"
  SetOutPath "$INSTDIR\official-plugins\dsh"
  File "${PACKAGE_DIR}\official-plugins\dsh\adapter.json"
  File "${PACKAGE_DIR}\official-plugins\dsh\agent-space-adapter-dsh.exe"
  File "${PACKAGE_DIR}\official-plugins\dsh\LICENSE"
  File "${PACKAGE_DIR}\official-plugins\dsh\THIRD-PARTY-NOTICES.txt"
  IfErrors in_use
  SetOutPath "$INSTDIR"
!endif
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Agent Space Adapter.lnk" "$INSTDIR\agent-space-native.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Agent Space Adapter"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\agent-space-native.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  Goto done
in_use:
  MessageBox MB_OK|MB_ICONSTOP "Quit Agent Space Adapter from the tray before installing." /SD IDOK
  SetErrorLevel 1
  Quit
done:
SectionEnd

Section "Uninstall"
  SetRegView 64
  IfFileExists "$INSTDIR\agent-space-native.exe" 0 remove_files
  ClearErrors
  Delete "$INSTDIR\agent-space-native.exe"
  IfErrors in_use
remove_files:
  Delete "$SMPROGRAMS\Agent Space Adapter.lnk"
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "agent-space-native"
  StrCmp $0 '"$INSTDIR\agent-space-native.exe" --background' 0 +2
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "agent-space-native"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
!ifdef OFFICIAL_PLUGINS
  Delete "$INSTDIR\official-plugins\codex\adapter.json"
  Delete "$INSTDIR\official-plugins\codex\agent-space-adapter-codex.exe"
  Delete "$INSTDIR\official-plugins\codex\LICENSE"
  Delete "$INSTDIR\official-plugins\codex\THIRD-PARTY-NOTICES.txt"
  RMDir "$INSTDIR\official-plugins\codex"
  Delete "$INSTDIR\official-plugins\dsh\adapter.json"
  Delete "$INSTDIR\official-plugins\dsh\agent-space-adapter-dsh.exe"
  Delete "$INSTDIR\official-plugins\dsh\LICENSE"
  Delete "$INSTDIR\official-plugins\dsh\THIRD-PARTY-NOTICES.txt"
  RMDir "$INSTDIR\official-plugins\dsh"
  RMDir "$INSTDIR\official-plugins"
!endif
  RMDir /r "$INSTDIR\gateway"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Goto done
in_use:
  MessageBox MB_OK|MB_ICONSTOP "Quit Agent Space Adapter from the tray before uninstalling." /SD IDOK
  SetErrorLevel 1
  Quit
done:
SectionEnd
