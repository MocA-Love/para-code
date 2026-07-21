# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
# Thin PowerShell entry for the Windows Codex pane launcher (PowerShell resolves a
# .ps1 ahead of codex.cmd in the same directory). All logic lives in
# paradisCodexPaneLauncher.cjs.
# A console-subsystem node.exe from PATH is preferred: the Para Code executable is a
# GUI-subsystem app, so running the launcher under it makes PowerShell return without
# waiting and detaches the console, and the interactive Codex TUI then fails with
# "stdin is not a terminal".

$paraCodexNode = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$paraCodexRunAsNode = $false
if (-not $paraCodexNode) {
	if ($env:PARA_CODE_CODEX_LAUNCHER_NODE) {
		# Fallback keeps non-interactive delegation working; interactive sessions need node.exe.
		$paraCodexNode = $env:PARA_CODE_CODEX_LAUNCHER_NODE
		$paraCodexRunAsNode = $true
	}
	else {
		[Console]::Error.WriteLine('Para Code: Node.js (node.exe) was not found on PATH for the Codex pane launcher.')
		exit 2
	}
}

# The script runs in the caller's process, so restore ELECTRON_RUN_AS_NODE afterwards
# instead of leaking it into the interactive session.
$paraPreviousRunAsNode = $env:ELECTRON_RUN_AS_NODE
if ($paraCodexRunAsNode) {
	$env:ELECTRON_RUN_AS_NODE = '1'
}
try {
	try {
		& $paraCodexNode "$PSScriptRoot\paradisCodexPaneLauncher.cjs" @args
	}
	catch {
		[Console]::Error.WriteLine("Para Code: could not start the Codex pane launcher: $($_.Exception.Message)")
		exit 1
	}
	if ($null -eq $LASTEXITCODE) { exit 1 } else { exit $LASTEXITCODE }
}
finally {
	if ($paraCodexRunAsNode) {
		if ($null -ne $paraPreviousRunAsNode) {
			$env:ELECTRON_RUN_AS_NODE = $paraPreviousRunAsNode
		}
		else {
			Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
		}
	}
}
