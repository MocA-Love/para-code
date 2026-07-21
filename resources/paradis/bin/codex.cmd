@echo off
rem PARA-CODE: fork-owned file (Para Code) - not present in upstream microsoft/vscode. See CLAUDE.md.
rem Thin cmd entry for the Windows Codex pane launcher. All logic lives in
rem paradisCodexPaneLauncher.cjs, executed with Para Code's own binary as Node.
rem The exe is invoked directly (no `call`) so arguments are not re-parsed by cmd.
setlocal
if not defined PARA_CODE_CODEX_LAUNCHER_NODE (
	echo Para Code: PARA_CODE_CODEX_LAUNCHER_NODE is not set. 1>&2
	endlocal & exit /b 2
)
set "ELECTRON_RUN_AS_NODE=1"
"%PARA_CODE_CODEX_LAUNCHER_NODE%" "%~dp0paradisCodexPaneLauncher.cjs" %*
endlocal & exit /b %ERRORLEVEL%
