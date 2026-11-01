@echo off
setlocal EnableExtensions
rem ===========================================================================
rem  ndebug - the standalone debug observatory (cmd.exe launcher).
rem
rem      ndebug debugtool\samples\py\app.py
rem      ndebug app.py --hz 20 --port 7400
rem      ndebug app.py -- 60
rem
rem  Prefers the packaged binary so the launcher and the shipped artefact run the
rem  same code; falls back to source (with this repo's TypeScript loader flags)
rem  so a checkout works before anything is built.
rem ===========================================================================
cd /d "%~dp0" || exit /b 1

if exist "dist\NDebug.exe" (
  "dist\NDebug.exe" %*
  exit /b %errorlevel%
)

node --experimental-transform-types --no-warnings --experimental-loader ./resolve-loader.mjs "src\debugtool\cli.ts" %*
exit /b %errorlevel%
