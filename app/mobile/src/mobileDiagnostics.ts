// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export type MobileDiagnosticReporter = (
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
) => void;

let reporter: MobileDiagnosticReporter | undefined;

export function configureMobileDiagnosticReporter(value: MobileDiagnosticReporter): void {
	reporter = value;
}

export function reportMobileDiagnosticError(
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
): void {
	reporter?.(feature, operation, error, safeExtra);
}
