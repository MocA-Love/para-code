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

/**
 * 計測値に付ける属性（`sentry.ts` の `MobileSpanAttributes` と同じ約束）。`safe_` 接頭辞は、
 * Sentry プロジェクト側の sensitiveFields（キーの部分一致で消す）から守る safeFields に合わせたもの。
 * 件数・サイズ・時間・種別だけを入れ、パス・名前・内容は載せない。
 */
export type MobileTimingAttributes = Record<`safe_${string}`, number | string | boolean>;

export type MobileTimingRecorder = (
	feature: string,
	operation: string,
	startedAt: number,
	endedAt: number,
	attributes: MobileTimingAttributes,
) => void;

let timingRecorder: MobileTimingRecorder | undefined;

export function configureMobileTimingRecorder(value: MobileTimingRecorder): void {
	timingRecorder = value;
}

/**
 * 済んだ処理1件の所要時間を、`para.<feature>.<operation>` の transaction として送る。
 * 開始・終了は `Date.now()` のミリ秒。await を跨いで span を張り続けられないため、区間ごとの
 * 時間は呼び出し側で測って attribute に載せ、ここでは終わった後に1回だけ呼ぶ。
 * Sentry が無効（開発ビルド・テスト）なら何もしない。
 */
export function recordMobileTiming(
	feature: string,
	operation: string,
	startedAt: number,
	endedAt: number,
	attributes: MobileTimingAttributes,
): void {
	try {
		timingRecorder?.(feature, operation, startedAt, endedAt, attributes);
	} catch { /* 計測の失敗で呼び出し元を止めない */ }
}
