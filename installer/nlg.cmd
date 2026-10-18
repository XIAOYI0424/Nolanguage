@echo off
rem ===========================================================================
rem  nlg - thin alias for the installed Nolanguage executable.
rem
rem  The exe is a Node SEA with the plugin manager built in, so this shim needs
rem  no Node and no source checkout: every argument is forwarded unchanged.
rem
rem      nlg lang ls
rem      nlg lang add D:\plugins\rust@1.0.0
rem      nlg lang off cpp
rem      nlg --dump-plugins
rem
rem  `start /wait /b` is deliberate:
rem    /wait  Nolanguage.exe is a GUI-subsystem image, so cmd.exe would
rem           otherwise return to the prompt while it is still printing;
rem    /b     share this console instead of opening a new one - without it the
rem           child's stdout is detached, so `nlg --dump-plugins > out.txt` and
rem           any pipe silently produced nothing.
rem ===========================================================================
setlocal
set "APP=%~dp0Nolanguage.exe"

if "%~1"=="" goto usage
start /wait /b "" "%APP%" %*
exit /b %errorlevel%

:usage
echo nlg - language plugin manager (bundled with Nolanguage; no Node required)
echo.
echo   nlg lang ls                       what is installed
echo   nlg lang add ^<dir^|zip^|url^|git^>   install and enable
echo   nlg lang off ^<id^> / on ^<id^>      disable / enable
echo   nlg lang rm ^<id^>                  uninstall (data is kept)
echo   nlg --dump-plugins                where every plugin came from
echo.
start /wait /b "" "%APP%" lang --help
exit /b %errorlevel%
