@echo off
rem ===========================================================================
rem  nlg - language plugin manager shipped with the installed app.
rem
rem  The executable is a Node SEA, so this shim needs no Node and no source
rem  checkout: it only forwards to the CLI that is already inside Nolanguage.exe.
rem
rem      nlg lang ls
rem      nlg lang add D:\plugins\rust@1.0.0
rem      nlg lang off cpp
rem      nlg --dump-plugins
rem
rem  `start /wait` is deliberate: Nolanguage.exe is a GUI-subsystem image, so
rem  cmd.exe would otherwise return to the prompt while it is still printing.
rem ===========================================================================
setlocal
set "APP=%~dp0Nolanguage.exe"

if "%~1"=="" goto usage
if /i "%~1"=="--dump-plugins" (
  start /wait "" "%APP%" --dump-plugins
  exit /b %errorlevel%
)
start /wait "" "%APP%" lang %*
exit /b %errorlevel%

:usage
echo nlg - language plugin manager (bundled with Nolanguage; no Node required)
echo.
echo   nlg lang ls                      what is installed
echo   nlg lang add ^<dir^|zip^|url^|git^>  install and enable
echo   nlg lang off ^<id^> / on ^<id^>     disable / enable
echo   nlg lang rm ^<id^>                 uninstall (data is kept)
echo   nlg --dump-plugins               where every plugin came from
echo.
start /wait "" "%APP%" lang --help
exit /b %errorlevel%
