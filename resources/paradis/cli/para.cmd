@echo off
rem PARA-CODE: fork-owned file (Para Code) - not present in upstream microsoft/vscode. See CLAUDE.md.
rem Windows launcher of the `para` command (the Para Code tools as a CLI). It finds a Node.js and
rem runs out\vs\paradis\contrib\agentBrowser\node\paradisCli.js. A console-subsystem node.exe from
rem PATH is preferred; without one the Para Code executable (PARA_CODE_CLI_NODE, set by Para Code in
rem its terminals) runs the script as Node.js (ELECTRON_RUN_AS_NODE=1).
setlocal
set "PARA_CLI_SCRIPT=%~dp0..\..\..\out\vs\paradis\contrib\agentBrowser\node\paradisCli.js"
if not exist "%PARA_CLI_SCRIPT%" (
	echo para: the Para Code CLI script was not found next to this launcher. Open a new terminal in Para Code and try again. Nothing was done. 1>&2
	endlocal & exit /b 3
)
set "PARA_CLI_NODE="
for %%i in (node.exe) do set "PARA_CLI_NODE=%%~$PATH:i"
if defined PARA_CLI_NODE goto :run
if not defined PARA_CODE_CLI_NODE goto :nonode
if not exist "%PARA_CODE_CLI_NODE%" goto :nonode
set "PARA_CLI_NODE=%PARA_CODE_CLI_NODE%"
set "ELECTRON_RUN_AS_NODE=1"
:run
"%PARA_CLI_NODE%" "%PARA_CLI_SCRIPT%" %*
endlocal & exit /b %ERRORLEVEL%
:nonode
echo para: no Node.js was found to run the Para Code CLI. Open a new terminal in Para Code and try again. Nothing was done. 1>&2
endlocal & exit /b 3
