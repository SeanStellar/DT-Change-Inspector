!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  Var DesktopShortcutCheckbox
  Var DesktopShortcutChoice

!macro customInit
  ${If} ${Silent}
    StrCpy $DesktopShortcutChoice ${BST_UNCHECKED}
  ${Else}
    StrCpy $DesktopShortcutChoice ${BST_CHECKED}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom DesktopShortcutPage DesktopShortcutPageLeave
!macroend

Function DesktopShortcutPage
  !insertmacro MUI_HEADER_TEXT "附加任务" "请选择安装完成后需要执行的附加任务"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 4u 100% 22u "桌面快捷方式"
  Pop $0
  ${NSD_CreateCheckbox} 8u 35u 92% 15u "创建双时相变化检查工具桌面快捷方式"
  Pop $DesktopShortcutCheckbox
  ${NSD_SetState} $DesktopShortcutCheckbox $DesktopShortcutChoice
  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutChoice
FunctionEnd

!macro customInstall
  ${If} $DesktopShortcutChoice == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\双时相变化检查工具.lnk" "$INSTDIR\双时相变化检查工具.exe"
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  Delete "$DESKTOP\双时相变化检查工具.lnk"
!macroend
