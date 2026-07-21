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
if defined PARA_CODE_CODEX_LAUNCHER_NODE (
	rem Fallback keeps non-interactive delegation working; interactive sessions need node.exe.
	set "PARA_CODEX_NODE=%PARA_CODE_CODEX_LAUNCHER_NODE%"
	set "ELECTRON_RUN_AS_NODE=1"
	goto :run
)
echo Para Code: Node.js (node.exe) was not found on PATH for the Codex pane launcher. 1>&2
endlocal & exit /b 2
:run
"%PARA_CODEX_NODE%" "%~dp0paradisCodexPaneLauncher.cjs" %*
endlocal & exit /b %ERRORLEVEL%
