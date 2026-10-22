@echo off
rem ===========================================================================
rem  nlg - thin alias for the installed Nolanguage engine.
rem
rem  The installed payload is two files: Nolanguage.exe (the Tauri shell the
rem  user opens - the desktop app) and NolanguageEngine.exe (the Node SEA
rem  engine, the same binary the shell spawns). The CLI belongs to the engine:
rem  the shell draws a window and takes no arguments, so this shim forwards to
rem  the engine, which carries the plugin manager built in - no Node, no source
rem  checkout.
rem
rem      nlg web                          open the web edition (browser)
rem      nlg lang ls                      what is installed
rem      nlg lang add D:\plugins\rust@1.0.0   install and enable
rem      nlg lang off cpp                  disable / enable
rem      nlg --dump-plugins                where every plugin came from
rem
rem  `nlg web` starts the engine's HTTP service and opens the system browser.
rem  It is the browser edition, not a second copy of the app: the desktop
rem  edition (what the user normally opens) runs its engine over a pipe and
rem  leaves the port free, so both can be up at once. An edition that is
rem  already serving is reused rather than started twice.
rem
rem  `start /wait /b` is deliberate for the passthrough form:
rem    /wait  NolanguageEngine.exe is a GUI-subsystem image, so cmd.exe would
rem           otherwise return to the prompt while it is still printing;
rem    /b     share this console instead of opening a new one - without it the
rem           child's stdout is detached, so `nlg --dump-plugins > out.txt` and
rem           any pipe silently produced nothing.
rem ===========================================================================
setlocal
set "APP=%~dp0NolanguageEngine.exe"
set "URL=http://127.0.0.1:7310/"

rem ---------------------------------------------------------------- web edition
if /i "%~1"=="web" goto web

if "%~1"=="" goto usage
start /wait /b "" "%APP%" %*
exit /b %errorlevel%

::usage
echo nlg - language plugin manager (bundled with Nolanguage; no Node required)
echo.
echo   nlg web                          open the web edition in your browser
echo   nlg lang ls                      what is installed
echo   nlg lang add ^<dir^|zip^|url^|git^>  install and enable
echo   nlg lang off ^<id^> / on ^<id^>     disable / enable
echo   nlg lang rm ^<id^>                 uninstall (data is kept)
echo   nlg --dump-plugins               where every plugin came from
echo.
start /wait /b "" "%APP%" lang --help
exit /b %errorlevel%

:web
rem Already serving? Reuse it - a second engine would fight over the port and
rem the workspace directory.
curl -s -o nul --max-time 2 "%URL%health"
if not errorlevel 1 (
  echo Nolanguage web edition is already running - opening the browser.
  start "" "%URL%"
  exit /b 0
)

echo Starting the Nolanguage web edition...
rem Detached on purpose: the engine is a server, and `nlg web` is a launcher,
rem not a shell you have to keep open. Its log lives in the telemetry DB.
start "" "%APP%"

rem Wait for it to answer before opening the browser, otherwise the first tab
rem lands on a refused connection. A cold start brings up the language servers,
rem so this can take a few seconds.
for /l %%i in (1,1,20) do (
  curl -s -o nul --max-time 2 "%URL%health"
  if not errorlevel 1 goto web_open
  timeout /t 1 /nobreak > nul
)

echo The web edition did not answer on %URL% within 20s.
echo Check the log: %LOCALAPPDATA%\Nolanguage\telemetry.db  ^(nlg logs tail^)
exit /b 1

:web_open
echo Web edition ready - opening the browser.
start "" "%URL%"
exit /b 0
