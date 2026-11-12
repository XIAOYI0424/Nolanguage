; ===========================================================================
; Nolanguage — NSIS installer source (MUI2, 中文界面).
;
; Build (from the repo root):
;     node installer/build-setup.mjs        ; the supported entry point
;     makensis /DAPP_EXE=<abs exe> /DOUTFILE=<abs setup> installer\Nolanguage.nsi
;
; Produces Nolanguage-Setup.exe, a normal Windows installer with
;   1. 欢迎页   2. 选择安装目录   3. 实时安装进度   4. 完成页（可勾选运行）
;
; The payload is the standalone Nolanguage.exe (Node SEA, self-contained); it
; provides two faces, selected by the launch flag:
;
;   Nolanguage (Web)     -> Nolanguage.exe --open-browser   (default browser)
;   Nolanguage (Desktop) -> Nolanguage.exe                  (native WebView window)
;
; Why NSIS and not the old Node-SEA installer: an SEA is a console-subsystem
; image, so double-clicking it *always* flashes a console window and it cannot
; draw a wizard. NSIS is a GUI-subsystem executable — no console, real pages.
; ===========================================================================

Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"

!ifndef APP_EXE
  !define APP_EXE "dist\Nolanguage.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "installer\Nolanguage-Setup.exe"
!endif

!define APP_NAME      "Nolanguage"
!define APP_VERSION   "0.7.19"
!define APP_PUBLISHER "Nolanguage"
!define APP_WEB_ARG   "--open-browser"
!define UNINST_KEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
BrandingText "${APP_NAME} ${APP_VERSION}"

; Per-user install: no UAC prompt, no admin rights needed.
RequestExecutionLevel user

; `%LOCALAPPDATA%\Programs` is where a per-user app belongs; the directory page
; lets the user override it, and the choice is remembered across upgrades.
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"

; Keep the details pane visible: it is the live log of what the installer is
; doing (closing the running app, unpacking, writing shortcuts).
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion"     "${APP_VERSION}"
VIAddVersionKey "ProductVersion"  "${APP_VERSION}"
VIAddVersionKey "LegalCopyright"  "${APP_PUBLISHER}"

; ---------------------------------------------------------------- 安装向导页

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME} ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "本向导将把 ${APP_NAME} 安装到您的电脑。$\r$\n$\r$\n${APP_NAME} 是一个自带运行时的一体化开发与运行平台：安装后无需 Node.js、Python 或其他依赖。$\r$\n$\r$\n点击“下一步”继续。"

!insertmacro MUI_PAGE_WELCOME

!define MUI_DIRECTORYPAGE_TEXT_TOP "${APP_NAME} 将安装到下面的文件夹。若要安装到其他位置，点击“浏览”选择另一个文件夹，或直接输入路径。"
!insertmacro MUI_PAGE_DIRECTORY

; 安装进度条 + 实时日志
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "${APP_NAME} 安装完成"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} 已安装到：$\r$\n$INSTDIR$\r$\n$\r$\n开始菜单和桌面上的快捷方式可以直接启动它。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_NAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "运行 ${APP_NAME} (Desktop)"
!insertmacro MUI_PAGE_FINISH

; ---------------------------------------------------------------- 卸载向导页

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 界面语言：简体中文为默认
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------------ 安装内容

Section "安装 ${APP_NAME}" SecInstall

  ; An upgrade must not fail on a locked file: close a running instance first.
  ; `nsExec` runs the command hidden, so no console window ever appears.
  DetailPrint "正在检查是否已运行 ${APP_NAME}…"
  nsExec::ExecToLog 'taskkill /IM "${APP_NAME}.exe" /F /T'
  Pop $0

  SetOutPath "$INSTDIR"
  SetOverwrite on

  DetailPrint "正在解压 ${APP_NAME}.exe…"
  File "${APP_EXE}"

  ; The CLI shim and the PATH helper travel with the app: `nlg` has to work on a
  ; machine that never installed Node or a source checkout, and the PATH edit
  ; has to be undoable, which is what path-tool.ps1's receipt is for.
  DetailPrint "正在安装 nlg 命令…"
  File "${__FILEDIR__}\nlg.cmd"
  File "${__FILEDIR__}\path-tool.ps1"

  DetailPrint "正在写入卸载程序…"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  DetailPrint "正在创建开始菜单快捷方式…"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Web).lnk"     "$INSTDIR\${APP_NAME}.exe" "${APP_WEB_ARG}" "$INSTDIR\${APP_NAME}.exe"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"           "$INSTDIR\${APP_NAME}.exe" ""              "$INSTDIR\${APP_NAME}.exe"
  ; Left over from earlier builds that shipped a separate "(Desktop)" entry.
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Desktop).lnk"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"

  DetailPrint "正在创建桌面快捷方式…"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe" "" "$INSTDIR\${APP_NAME}.exe"

  ; HKCU PATH, with a receipt recording the exact previous value, so uninstall
  ; restores it instead of deleting anything that looks like ours.
  DetailPrint "正在把 nlg 加入用户 PATH（可在卸载时精确还原）…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\path-tool.ps1" -Action add -InstallDir "$INSTDIR"'
  Pop $0

  DetailPrint "正在写入注册表（设置 → 应用 中可卸载）…"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"         "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"         "$INSTDIR\${APP_NAME}.exe,0"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"      "${APP_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"           "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation"     "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString"     '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify"            1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair"            1

  ; A fixed estimate rather than `${GetSize}`: scanning the freshly written
  ; 90 MB tree stalls the progress bar for seconds on a machine with real-time
  ; antivirus, and the value only feeds "Settings → Apps" size display.
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 95000

  DetailPrint "安装完成。"
SectionEnd

; -------------------------------------------------------------------- 卸载内容

Section "Uninstall"

  DetailPrint "正在关闭 ${APP_NAME}…"
  nsExec::ExecToLog 'taskkill /IM "${APP_NAME}.exe" /F /T'
  Pop $0

  ; Restore PATH before the helper script is deleted with the directory.
  DetailPrint "正在还原用户 PATH（按安装时记录的 receipt）…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\path-tool.ps1" -Action remove -InstallDir "$INSTDIR"'
  Pop $0

  DetailPrint "正在删除程序文件…"
  Delete "$INSTDIR\${APP_NAME}.exe"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\nlg.cmd"
  Delete "$INSTDIR\path-tool.ps1"
  ; The helper removes its own receipt; delete it here as well so a receipt can
  ; never survive the uninstall that was supposed to consume it.
  Delete "$LOCALAPPDATA\Nolanguage\install-receipt.json"

  DetailPrint "正在删除快捷方式…"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Web).lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Desktop).lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  ; Only removes the folder when it is empty: user data (`.nolanguage`, the
  ; per-user WebView profile and telemetry DB) is deliberately kept.
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
