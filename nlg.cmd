@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ===========================================================================
rem  Nolanguage - nlg, the conversion layer (cmd.exe twin of the `nlg` script).
rem
rem      nlg run lang-install -- install examples/cpp@1.0.0
rem      nlg run lang-install -- list
rem      nlg run verify-plugins
rem      nlg ide
rem
rem  Turns a short command into the exact node invocation this repo needs (the
rem  TypeScript transform flags plus the `.js` -> `.ts` resolver). Keep this in
rem  sync with the bash script of the same name.
rem
rem  Implementation note: `%*` in this interpreter keeps the *original* command
rem  tail and ignores `shift`, so the argument tail is collected by hand below.
rem  `%1` (not `%~1`) is used there on purpose - it keeps the quotes the caller
rem  typed, which is what a path with spaces needs.
rem ===========================================================================

cd /d "%~dp0" || exit /b 1

set "FIRST=%~1"

if /i "%FIRST%"=="help" goto usage
if /i "%FIRST%"=="-h" goto usage
if /i "%FIRST%"=="--help" goto usage
if /i "%FIRST%"=="scripts" goto scripts

rem `run` is a keyword, not a script name: drop it so `nlg run x` == `nlg x`.
if /i "%FIRST%"=="run" shift

if "%~1"=="" (
  echo nlg: what should I run? ^(try: nlg help^) 1>&2
  exit /b 2
)

set "NAME=%~1"
shift

rem `--` separates the command from its arguments and is not one of them.
if "%~1"=="--" shift

rem ---- collect the tail: %* ignores shift, so walk the arguments instead ----
set "ARGS="
:collect
if "%~1"=="" goto collected
set "ARGS=!ARGS! %1"
shift
goto collect
:collected

if exist "scripts\%NAME%.ts" (
  node --experimental-transform-types --experimental-loader ./resolve-loader.mjs "scripts\%NAME%.ts" !ARGS!
  exit /b %errorlevel%
)
if exist "scripts\%NAME%.mjs" (
  node "scripts\%NAME%.mjs" !ARGS!
  exit /b %errorlevel%
)
if /i "%NAME%"=="ide" (
  node --experimental-transform-types --experimental-loader ./resolve-loader.mjs "src\panel\server.ts" !ARGS!
  exit /b %errorlevel%
)
if /i "%NAME%"=="panel" (
  node --experimental-transform-types --experimental-loader ./resolve-loader.mjs "src\panel\server.ts" !ARGS!
  exit /b %errorlevel%
)

echo nlg: no script named "%NAME%" 1>&2
echo available: 1>&2
for %%f in (scripts\*.ts scripts\*.mjs) do @echo   %%~nf 1>&2
exit /b 2

rem ------------------------------------------------------------------- usage
:usage
echo nlg - the conversion layer between a short command and the exact node call
echo.
echo   nlg run ^<script^> [--] [args...]   run scripts\^<script^>.ts ^(or .mjs^)
echo   nlg ^<script^> [args...]            same, `run` is optional
echo   nlg ide [args...]                 the editor backend
echo   nlg help                          this text
echo   nlg scripts                       list what can be run
echo.
echo examples:
echo   nlg run lang-install -- install examples\cpp@1.0.0
echo   nlg run lang-install -- list
echo   nlg run verify-plugins
exit /b 0

rem ----------------------------------------------------------------- scripts
:scripts
echo scripts/ ^(nlg run ^<name^>^):
for %%f in (scripts\*.ts scripts\*.mjs) do @echo   %%~nf
exit /b 0
