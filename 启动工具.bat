@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NEW_PORTABLE_EXE=%~dp0release-x-swap\win-unpacked\双时相变化检查工具.exe"
set "PORTABLE_EXE=%~dp0release\win-unpacked\双时相变化检查工具.exe"
set "DEFAULT_INSTALLED_EXE=%LOCALAPPDATA%\Programs\双时相变化检查工具\双时相变化检查工具.exe"

if exist "%NEW_PORTABLE_EXE%" (
    start "" "%NEW_PORTABLE_EXE%"
    exit /b 0
)

if exist "%PORTABLE_EXE%" (
    start "" "%PORTABLE_EXE%"
    exit /b 0
)

if exist "%DEFAULT_INSTALLED_EXE%" (
    start "" "%DEFAULT_INSTALLED_EXE%"
    exit /b 0
)

echo 没有找到 Electron 版程序。
echo 请先运行：release\双时相变化检查工具-安装程序-3.0.0.exe
echo 如果安装时选择了自定义路径，请使用桌面或开始菜单快捷方式启动。
echo.
pause
exit /b 1
