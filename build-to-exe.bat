@echo off
setlocal EnableExtensions
rem ===========================================================================
rem  Nolanguage - one-click build.
rem
rem  Default (no argument) runs the whole chain and ends with the installer:
rem
rem      build-to-exe.bat            engine, desktop shell, Nolanguage-Setup.exe
rem      build-to-exe.bat exe        engine only: dist\Nolanguage.exe (fastest)
rem      build-to-exe.bat run        full chain, then start dist\Nolanguage.exe
rem      build-to-exe.bat install    full chain, then open the installer wizard
rem      build-to-exe.bat clean      remove build\, dist\ and frontend\dist\
rem
rem  Why three steps, in this order (each one feeds the next):
rem
rem    1. scripts\build-exe.mjs      src and builtin become dist\Nolanguage.exe,
rem                                  a Node SEA image that carries its own
rem                                  runtime, so no Node is needed to run it.
rem    2. tauri build --no-bundle    compiles frontend\dist into the desktop
rem                                  shell and syncs the engine into the
rem                                  sidecar slot, producing
rem                                  src-tauri\target\release\*.exe.
rem                                  --no-bundle skips msi/nsis, which would
rem                                  only duplicate what step 3 does.
rem    3. installer\build-setup.mjs  NSIS packs both exes into
rem                                  installer\Nolanguage-Setup.exe.
rem
rem  installer\build-setup.mjs rejects stale inputs (a page or engine newer
rem  than the shell), so dropping one of these steps fails loudly instead of
rem  shipping an installer that still contains the previous UI.
rem ===========================================================================

cd /d "%~dp0"

set "NAME=Nolanguage.exe"
set "EXE=dist\%NAME%"
set "SETUP=installer\Nolanguage-Setup.exe"
set "SHELL=src-tauri\target\release\nolanguage.exe"

set "MODE=%~1"
if /i "%MODE%"=="clean" goto clean
if /i "%MODE%"=="exe" goto engine_only

echo ============================================================
echo   Nolanguage - engine, desktop shell and installer
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo [i] node %NODEV%
echo [i] project %CD%
echo [i] output  %SETUP%

if not exist "node_modules\.bin\tauri.cmd" goto notauri
set "TAURI=node_modules\.bin\tauri.cmd"

where cargo >nul 2>nul
if errorlevel 1 goto nocargo

rem A running instance holds its exe open on Windows and the copy fails, so
rem close every process the build is about to overwrite.
rem `findstr` rather than `find`: it cannot be shadowed by a POSIX `find` when
rem this script is started from a MSYS/Git-Bash-derived environment.
call :kill "%NAME%"
call :kill "nolanguage.exe"
call :kill "NolanguageEngine.exe"

rem Elapsed time comes from PowerShell's Unix clock. Every capture is optional:
rem when PowerShell is unavailable the stamps stay empty and the timing lines
rem are skipped - the build itself never depends on them.
set "T0="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[int]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds" 2^>nul`) do set "T0=%%t"

rem -------------------------------------------------------------- 1. engine
echo.
echo [1/3] engine: src and builtin become %EXE%
node scripts\build-exe.mjs
if errorlevel 1 goto fail_engine
set "T1="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[int]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds" 2^>nul`) do set "T1=%%t"
if defined T0 if defined T1 set /a "D1=T1-T0" 2>nul
if defined D1 echo     took %D1%s

rem --------------------------------------------------------- 2. desktop shell
echo.
echo [2/3] shell: page and sidecar become %SHELL%
echo       (Rust release build, this is the slow step)
rem `call` is mandatory: tauri.cmd is itself a batch file, and invoking one
rem without `call` transfers control for good - this script would end right
rem here, still reporting exit code 0, and never reach the installer step.
call "%TAURI%" build --no-bundle
if errorlevel 1 goto fail_shell
set "T2="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[int]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds" 2^>nul`) do set "T2=%%t"
if defined T1 if defined T2 set /a "D2=T2-T1" 2>nul
if defined D2 echo     took %D2%s

rem ------------------------------------------------------------- 3. installer
echo.
echo [3/3] installer: NSIS packs the shell and engine into %SETUP%
node installer\build-setup.mjs
if errorlevel 1 goto fail_setup
set "T3="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[int]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds" 2^>nul`) do set "T3=%%t"
if defined T2 if defined T3 set /a "D3=T3-T2" 2>nul
if defined D3 echo     took %D3%s

echo.
echo ============================================================
if defined T0 if defined T3 set /a "TOTAL=T3-T0" 2>nul
if defined TOTAL echo   finished in %TOTAL%s
echo   done
echo ============================================================
for %%f in ("%EXE%") do echo [ok] %EXE%  (%%~zf bytes)
for %%f in ("%SHELL%") do echo [ok] %SHELL%  (%%~zf bytes)
for %%f in ("%SETUP%") do echo [ok] %SETUP%  (%%~zf bytes)

if /i "%MODE%"=="run" goto launch_exe
if /i "%MODE%"=="install" goto launch_setup
echo.
echo     Double-click %SETUP% to install or upgrade. It remembers the
echo     previous install directory, so no uninstall is needed first.
goto done

:launch_exe
echo.
echo [i] starting %EXE% ...
start "" "%EXE%"
goto done

:launch_setup
echo.
echo [i] opening the installer wizard ...
start "" "%SETUP%"
goto done

rem ------------------------------------------------------- engine only (fast)
:engine_only
echo ============================================================
echo   Nolanguage - standalone executable only
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo [i] node %NODEV%
echo [i] project %CD%
echo.

call :kill "%NAME%"
call :kill "nolanguage.exe"

set "T0="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[int]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds" 2^>nul`) do set "T0=%%t"
node scripts\build-exe.mjs
if errorlevel 1 goto fail_engine
if not exist "%EXE%" goto fail_engine
set "T1="
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "[int]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds" 2^>nul`) do set "T1=%%t"
if defined T0 if defined T1 set /a "D1=T1-T0" 2>nul
if defined D1 echo     took %D1%s

echo.
for %%f in ("%EXE%") do echo [ok] built %EXE%  (%%~zf bytes)
echo.
echo [i] the installer is NOT rebuilt in this mode. Run build-to-exe.bat
echo     without an argument to also refresh %SETUP%
goto done

rem ------------------------------------------------------------------ clean
:clean
echo [i] removing build\, dist\ and frontend\dist\ ...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist frontend\dist rmdir /s /q frontend\dist
echo [ok] cleaned
echo [i] src-tauri\target\ is kept: deleting it costs a full Rust rebuild.
goto done

rem ---------------------------------------------------------------- helpers
:kill
rem %1 = image name. Silent when the process is not running.
tasklist /nh /fi "imagename eq %~1" 2>nul | findstr /i /c:"%~1" >nul
if errorlevel 1 exit /b 0
echo [i] closing %~1 so its binary can be replaced
taskkill /im "%~1" /f >nul 2>nul
exit /b 0

rem ----------------------------------------------------------------- errors
:nonode
echo [x] Node.js was not found on PATH.
echo     Install the LTS build from https://nodejs.org and run this again.
goto failed

:notauri
echo [x] the Tauri CLI is missing: node_modules\.bin\tauri.cmd
echo     Run "npm install" once in this folder and try again.
goto failed

:nocargo
echo [x] cargo was not found on PATH - the desktop shell is a Rust program.
echo     Install the toolchain from https://rustup.rs and open a new terminal.
goto failed

:fail_engine
echo.
echo [x] engine build failed - see the messages above.
echo     The bundle stays in build\ so the failure can be inspected.
goto failed

:fail_shell
echo.
echo [x] desktop shell build failed - see the Rust/cargo messages above.
echo     Nothing was packed into the installer, so the old one is untouched.
goto failed

:fail_setup
echo.
echo [x] installer build failed - see the messages above.
echo     If it reports a stale payload, rerun this script without arguments.
goto failed

:failed
echo.
if not defined MODE pause
endlocal
exit /b 1

:done
echo.
if not defined MODE pause
endlocal
exit /b 0
