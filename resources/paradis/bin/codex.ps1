# PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
# Thin PowerShell entry for the Windows Codex pane launcher (PowerShell resolves a
# .ps1 ahead of codex.cmd in the same directory). All logic lives in
# paradisCodexPaneLauncher.cjs, executed with Para Code's own binary as Node.

if (-not $env:PARA_CODE_CODEX_LAUNCHER_NODE) {
	[Console]::Error.WriteLine('Para Code: PARA_CODE_CODEX_LAUNCHER_NODE is not set.')
	exit 2
}

# The script runs in the caller's process, so restore ELECTRON_RUN_AS_NODE afterwards
# instead of leaking it into the interactive session.
$paraPreviousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
try {
	try {
		& $env:PARA_CODE_CODEX_LAUNCHER_NODE "$PSScriptRoot\paradisCodexPaneLauncher.cjs" @args
	}
	catch {
		[Console]::Error.WriteLine("Para Code: could not start the Codex pane launcher: $($_.Exception.Message)")
		exit 1
	}
	if ($null -eq $LASTEXITCODE) { exit 1 } else { exit $LASTEXITCODE }
}
finally {
	if ($null -ne $paraPreviousRunAsNode) {
		$env:ELECTRON_RUN_AS_NODE = $paraPreviousRunAsNode
	}
	else {
		Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
	}
}
