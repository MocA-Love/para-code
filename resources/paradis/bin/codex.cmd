@echo off
rem PARA-CODE: fork-owned file (Para Code) - not present in upstream microsoft/vscode. See CLAUDE.md.
rem Thin cmd entry for the Windows Codex pane launcher. All logic lives in
rem paradisCodexPaneLauncher.cjs. The exe is invoked directly (no `call`) so
rem arguments are not re-parsed by cmd.
rem A console-subsystem node.exe from PATH is preferred: the Para Code executable
rem is a GUI-subsystem app, so running the launcher under it detaches the console
rem and the interactive Codex TUI fails with "stdin is not a terminal".
setlocal
set "PARA_CODEX_NODE="
for %%i in (node.exe) do set "PARA_CODEX_NODE=%%~$PATH:i"
if defined PARA_CODEX_NODE goto :run
if not defined PARA_CODE_CODEX_LAUNCHER_NODE goto :nonode
if not defined PARA_CODE_CODEX_APP_SERVER_ENDPOINT goto :direct
rem Fallback keeps non-interactive delegation working; interactive sessions need node.exe.
set "PARA_CODEX_NODE=%PARA_CODE_CODEX_LAUNCHER_NODE%"
set "ELECTRON_RUN_AS_NODE=1"
goto :run
:direct
rem The pane app-server is turned off, so the launcher is on PATH only to keep Codex off
rem its shared background server, which needs the launcher script. Without node.exe that
rem cannot be done without breaking the interactive session, so run the user's Codex
rem unchanged: the launcher only looks it up (it prints the path) and this script runs it,
rem keeping the terminal's console. The outer quotes survive cmd /c's quote stripping.
set "PARA_CODEX_REAL="
set "ELECTRON_RUN_AS_NODE=1"
set "PARA_CODE_CODEX_LAUNCHER_MODE=resolve"
for /f "usebackq delims=" %%i in (`""%PARA_CODE_CODEX_LAUNCHER_NODE%" "%~dp0paradisCodexPaneLauncher.cjs""`) do if not defined PARA_CODEX_REAL set "PARA_CODEX_REAL=%%i"
set "ELECTRON_RUN_AS_NODE="
set "PARA_CODE_CODEX_LAUNCHER_MODE="
if not defined PARA_CODEX_REAL (
	echo Para Code: Codex executable was not found after the pane launcher. 1>&2
	endlocal & exit /b 127
)
"%PARA_CODEX_REAL%" %*
endlocal & exit /b %ERRORLEVEL%
:nonode
echo Para Code: Node.js (node.exe) was not found on PATH for the Codex pane launcher. 1>&2
endlocal & exit /b 2
:run
"%PARA_CODEX_NODE%" "%~dp0paradisCodexPaneLauncher.cjs" %*
endlocal & exit /b %ERRORLEVEL%
