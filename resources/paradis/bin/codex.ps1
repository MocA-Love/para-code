# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
# Thin PowerShell entry for the Windows Codex pane launcher (PowerShell resolves a
# .ps1 ahead of codex.cmd in the same directory). All logic lives in
# paradisCodexPaneLauncher.cjs.
# A console-subsystem node.exe from PATH is preferred: the Para Code executable is a
# GUI-subsystem app, so running the launcher under it makes PowerShell return without
# waiting and detaches the console, and the interactive Codex TUI then fails with
# "stdin is not a terminal".

$paraCodexNode = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $paraCodexNode -and $env:PARA_CODE_CODEX_LAUNCHER_NODE) {
	# The launcher only keeps Codex off its shared background server, which needs the launcher
	# script. Without node.exe that cannot be done without breaking the interactive session, so
	# run the user's Codex unchanged: the launcher only looks it up (it prints the path) and this
	# script runs it in this console.
	$paraPreviousRunAsNode = $env:ELECTRON_RUN_AS_NODE
	$env:ELECTRON_RUN_AS_NODE = '1'
	$env:PARA_CODE_CODEX_LAUNCHER_MODE = 'resolve'
	try {
		$paraCodexReal = & $env:PARA_CODE_CODEX_LAUNCHER_NODE "$PSScriptRoot\paradisCodexPaneLauncher.cjs" | Select-Object -First 1
	}
	catch {
		$paraCodexReal = $null
	}
	finally {
		Remove-Item Env:PARA_CODE_CODEX_LAUNCHER_MODE -ErrorAction SilentlyContinue
		if ($null -ne $paraPreviousRunAsNode) {
			$env:ELECTRON_RUN_AS_NODE = $paraPreviousRunAsNode
		}
		else {
			Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
		}
	}
	if (-not $paraCodexReal) {
		[Console]::Error.WriteLine('Para Code: Codex executable was not found after the pane launcher.')
		exit 127
	}
	& $paraCodexReal @args
	if ($null -eq $LASTEXITCODE) { exit 1 } else { exit $LASTEXITCODE }
}
if (-not $paraCodexNode) {
	[Console]::Error.WriteLine('Para Code: Node.js (node.exe) was not found on PATH for the Codex pane launcher.')
	exit 2
}

try {
	& $paraCodexNode "$PSScriptRoot\paradisCodexPaneLauncher.cjs" @args
}
catch {
	[Console]::Error.WriteLine("Para Code: could not start the Codex pane launcher: $($_.Exception.Message)")
	exit 1
}
if ($null -eq $LASTEXITCODE) { exit 1 } else { exit $LASTEXITCODE }
