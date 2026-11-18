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

; ------------------------------------------------------------------ 安装日志
;
; `LogSet` is only available when makensis was built with NSIS_CONFIG_LOG, and
; the one this project ships against refuses it outright ("LogSet specified,
; NSIS_CONFIG_LOG not defined"). So the log is written by the script itself, and
; it answers the only question a failed upgrade raises: which step decided the
; file was busy, and what was holding it. `exited with 2` says none of that.
;
; Written through `cmd /c echo >>`, not `FileOpen ... a`: appending from NSIS
; here produced a file whose only surviving line was the last one written, which
; is worse than no log at all. Keep the text ASCII and free of `&`, `>` and `%`
; — cmd is doing the writing. `%DATE% %TIME%` are expanded by cmd itself, so the
; timestamp costs nothing extra: "step3 took 40 s" is invisible without it.
!define INSTLOG "$TEMP\Nolanguage-install.log"

!macro LOGMSG text
  nsExec::Exec 'cmd /c echo [%DATE:~0,10% %TIME%] ${text}>>"%TEMP%\Nolanguage-install.log"'
  Pop $0
!macroend

!macro LOGVAL label value
  nsExec::Exec 'cmd /c echo [%DATE:~0,10% %TIME%] ${label}=[${value}]>>"%TEMP%\Nolanguage-install.log"'
  Pop $0
!macroend

!ifndef APP_EXE
  !define APP_EXE "dist\Nolanguage.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "installer\Nolanguage-Setup.exe"
!endif

!define APP_NAME      "Nolanguage"
; `build-setup.mjs` passes this from package.json (`/DAPP_VERSION=…`), so the
; Add/Remove entry and the file version can never disagree with the build. The
; fallback is for a hand-run `makensis`, and `verify:handshake` asserts it is
; the same number — a stale copy here once registered 0.7.23 while the app was
; 0.7.24, which is invisible until someone reads Add/Remove Programs.
!ifndef APP_VERSION
  !define APP_VERSION "0.7.24"
!endif
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

  ; ---- log header (truncates: one run, one file) -------------------------
  ; Delete rather than `FileOpen ... w`: a truncating open followed by appends
  ; from the same section produced a file whose first line was the *last* one
  ; written, which is worse than no log. Every write below is an append.
  Delete "${INSTLOG}"
  !insertmacro LOGMSG "${APP_NAME} installer"
  !insertmacro LOGVAL "  INSTDIR" "$INSTDIR"
  StrCpy $8 "no"
  IfSilent 0 +2
  StrCpy $8 "yes"
  !insertmacro LOGVAL "  silent" "$8"

  ; An upgrade must not fail on a locked file: close the instance we are about to
  ; overwrite. Not `taskkill /IM`: that kills every Nolanguage on the machine,
  ; including an editor the user has open and a copy installed somewhere else —
  ; which is exactly what an install-smoke run is. The helper is extracted first
  ; because it has to exist before the exe is replaced; it is a new file, so the
  ; running instance cannot be holding it.
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "${__FILEDIR__}\stop-instance.ps1"

  ; ---- step 1: ask the helper to stop the instance under $INSTDIR ---------
  DetailPrint "正在检查是否已运行 ${APP_NAME}…"
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\stop-instance.ps1" -Exe "$INSTDIR\${APP_NAME}.exe"'
  Pop $0
  Pop $1
  !insertmacro LOGVAL "step1 helper exit" "$0"

  ; The helper exits 0 when the file is writable, 1 when it is *sure* it is not.
  ; Anything else from nsExec ("error", a timeout, PowerShell missing or blocked
  ; by policy) means "could not ask" — which is not the same as "not locked".
  ; Both non-zero cases fall through to the pid fallback below; only a proven
  ; lock may abort. Aborting on "could not ask" turned a working install into
  ; "the installer does nothing".
  StrCpy $5 $0
  StrCmp $5 "0" inst_writable

  ; ---- step 2: the app recorded its own pid; use it ----------------------
  ; This is also the machine where the helper cannot run at all: a bare number
  ; in a one-line file needs no interpreter.
  StrCpy $7 ""
  IfFileExists "$LOCALAPPDATA\${APP_NAME}\server.pid" 0 inst_no_pid_kill
    FileOpen $9 "$LOCALAPPDATA\${APP_NAME}\server.pid" r
    FileRead $9 $7
    FileClose $9
    ; No trimming: the app writes the number with no line ending.
  inst_no_pid_kill:
  StrCmp $7 "" inst_after_pid
    !insertmacro LOGVAL "step2 session pid" "$7"
    nsExec::ExecToStack 'taskkill /PID $7 /T /F'
    Pop $0
    Pop $1
    !insertmacro LOGVAL "step2 taskkill exit" "$0"
  inst_after_pid:

  ; Unknown verdict: the kill above may well have freed the file, and the
  ; extractor is the next thing that can tell. Do not abort on a guess.
  StrCmp $5 "1" 0 inst_writable

  ; Proven locked: ask the helper once more, now that the pid kill ran. It is
  ; what knows how to wait for the image to be unmapped, so its verdict decides.
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\stop-instance.ps1" -Exe "$INSTDIR\${APP_NAME}.exe"'
  Pop $0
  Pop $1
  !insertmacro LOGVAL "step2 helper retry exit" "$0"
  StrCmp $0 "1" inst_locked inst_writable

  inst_locked:
    !insertmacro LOGMSG "ABORT: payload still locked"
    IfSilent 0 +3
      SetErrorLevel 2
      Quit
    MessageBox MB_ICONSTOP|MB_OK "无法写入 $INSTDIR\${APP_NAME}.exe：文件仍被占用。$\r$\n$\r$\n请先退出 ${APP_NAME}（任务管理器里确认没有 ${APP_NAME}.exe），再重新运行安装程序。$\r$\n$\r$\n日志：${INSTLOG}"
    Abort
  inst_writable:

  DetailPrint "正在解压 ${APP_NAME}.exe…"
  ; Staged under a different name, then swapped in.
  ;
  ; Writing the payload straight over the old file means an 85 MB write racing
  ; the scanner and the indexer for the whole duration — the "confirmed writable,
  ; still failed" window. Written as `.new` the write is uncontended, and the
  ; only contested moment is one rename. If that fails the log says so and the
  ; old exe is still there, which is a better outcome than a half-written one.
  !insertmacro LOGMSG "step3 extracting payload (staged)"
  File "/oname=${APP_NAME}.exe.new" "${APP_EXE}"
  !insertmacro LOGMSG "step3 staged"
  Delete "$INSTDIR\${APP_NAME}.exe"
  Rename "$INSTDIR\${APP_NAME}.exe.new" "$INSTDIR\${APP_NAME}.exe"
  IfFileExists "$INSTDIR\${APP_NAME}.exe.new" 0 inst_swap_ok
    !insertmacro LOGMSG "ABORT: swap failed - old exe still in place, payload left as .new"
    IfSilent 0 +3
      SetErrorLevel 3
      Quit
    MessageBox MB_ICONSTOP|MB_OK "无法替换 $INSTDIR\${APP_NAME}.exe：旧文件仍被占用。$\r$\n$\r$\n请退出 ${APP_NAME} 后重试；新文件已解压为 ${APP_NAME}.exe.new，无需重新下载。$\r$\n$\r$\n日志：${INSTLOG}"
    Abort
  inst_swap_ok:
  !insertmacro LOGMSG "step3 swapped in"

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
  ; Delete first: `CreateShortcut` does not reliably replace an existing .lnk —
  ; when the old one is held by Explorer it fails silently and the stale link
  ; survives. That is how the Start Menu kept pointing at a %TEMP% directory long
  ; after it had been deleted.
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Web).lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
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
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\path-tool.ps1" -Action add -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  !insertmacro LOGVAL "step4 path-tool exit" "$0"

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

  !insertmacro LOGMSG "done: install completed"

  DetailPrint "安装完成。"
SectionEnd

; -------------------------------------------------------------------- 卸载内容

Section "Uninstall"

  ; Same rule as the installer: stop the instance under *this* $INSTDIR. An
  ; uninstaller run from a copy must not take the real install down with it.
  DetailPrint "正在关闭 ${APP_NAME}…"
  IfFileExists "$INSTDIR\stop-instance.ps1" 0 +2
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\stop-instance.ps1" -Exe "$INSTDIR\${APP_NAME}.exe"'
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
  Delete "$INSTDIR\stop-instance.ps1"

  ; Everything below is machine-wide state, and it belongs to whichever copy the
  ; machine is registered to. An uninstaller run from a copy (a %TEMP% install, a
  ; portable copy, the install smoke) must not take the real install's
  ; registration or shortcuts with it — that is exactly how one temp uninstall
  ; removed the entry for D:\Nolanguage and left the Start Menu pointing at a
  ; directory that no longer existed.
  ReadRegStr $0 HKCU "${UNINST_KEY}" "InstallLocation"
  StrCmp $0 "$INSTDIR" 0 uninst_not_ours

  DetailPrint "正在删除快捷方式…"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Web).lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} (Desktop).lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  ; The helper removes its own receipt; delete it here as well so a receipt can
  ; never survive the uninstall that was supposed to consume it.
  Delete "$LOCALAPPDATA\Nolanguage\install-receipt.json"
  DeleteRegKey HKCU "${UNINST_KEY}"
  Goto uninst_done

uninst_not_ours:
  DetailPrint "跳过注册表与快捷方式：注册指向 $0，不是 $INSTDIR"

uninst_done:
  ; Only removes the folder when it is empty: user data (`.nolanguage`, the
  ; per-user WebView profile and telemetry DB) is deliberately kept.
  RMDir "$INSTDIR"
SectionEnd
