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

let tagSetter: ((key: string, value: string) => void) | undefined;

export function configureMobileDiagnosticTagSetter(value: (key: string, value: string) => void): void {
	tagSetter = value;
}

/**
 * PC側と突き合わせるための非PIIな相関IDを設定する。
 *
 * 両側とも Sentry の `user` を落としているため、これが無いと「PC側の切断」と「同時刻の
 * モバイル側のエラー」が同じ事象なのか判定できない。deviceId 自体はペアリングURIに載る値
 * なので、そのままではなくハッシュ断片だけを送る（PC側と同じ算出規則）。
 */
export function setMobileDiagnosticCorrelationTag(key: 'para.pairing', value: string): void {
	tagSetter?.(key, value);
}

export function reportMobileDiagnosticError(
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
): void {
	reporter?.(feature, operation, error, safeExtra);
}
