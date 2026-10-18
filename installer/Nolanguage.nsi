; ===========================================================================
; Nolanguage — NSIS installer source.
;
; Build (from the repo root):
;     installer\build-nsis.bat            ; uses dist\Nolanguage.exe by default
;     makensis /DAPP_EXE=dist\Nolanguage.exe installer\Nolanguage.nsi
;
; Produces Nolanguage-Setup.exe, which installs the standalone Nolanguage.exe
; (Node SEA, self-contained) and creates TWO launch entries in the Start Menu:
;
;   Nolanguage (Web)     -> Nolanguage.exe --open-browser   (default browser)
;   Nolanguage (Desktop) -> Nolanguage.exe                  (native WebView window)
;
; The same executable provides both faces; only the launch flag differs.
; ===========================================================================

!ifndef APP_EXE
  !define APP_EXE "dist\Nolanguage.exe"
!endif

!define APP_NAME    "Nolanguage"
!define APP_VERSION "0.6.0"
!define APP_PUBL    "Nolanguage"
!define APP_WEB     "--open-browser"
!define UNINST_KEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME}"
OutFile "installer\Nolanguage-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user
Unicode True

Page directory
Page instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "${APP_EXE}"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Web).lnk"     "$INSTDIR\${APP_NAME}.exe" "${APP_WEB}" "$INSTDIR\${APP_NAME}.exe"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Desktop).lnk" "$INSTDIR\${APP_NAME}.exe" ""          "$INSTDIR\${APP_NAME}.exe"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"             "$INSTDIR\uninstall.exe"

  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe" "" "$INSTDIR\${APP_NAME}.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher"       "${APP_PUBL}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${APP_NAME}.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir  "$INSTDIR"

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Web).lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Desktop).lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"

  Delete "$DESKTOP\${APP_NAME}.lnk"

  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
