// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { fsResponseRequestId, timingExtension } from '../../fsRequestTiming.js';
import { recordMobileTiming, type MobileTimingAttributes, type MobileTimingRecorder } from '../../mobileDiagnostics.js';

export type FileViewerLoadOutcome = 'ok' | 'error' | 'cancelled';

/** 表示用の HTML を組み立てる処理を測る（`useMemo` の中で使う）。 */
export function measureBuild<T>(build: () => T, now: () => number = Date.now): { readonly value: T; readonly ms: number } {
	const startedAt = now();
	const value = build();
	return { value, ms: now() - startedAt };
}

/**
 * ファイルビューアで1つのファイルを開いてから表示し終えるまでを測り、`para.mobileFileViewer.display`
 * の transaction として1件送る。PC との往復の内訳は `para.mobileFileViewer.fetch`（`fsRequestTiming.ts`）
 * が別に送るので、`safe_request_id` で突き合わせる。
 *
 * 区間（ms）:
 * - `safe_fetch_ms`: 読み込み開始〜PC の応答を受け取って中身を画面へ渡すまで
 * - `safe_html_build_ms`: 表示用 HTML の組み立て（Markdown の変換・コードの行番号付け・Office の包み直し）
 * - `safe_file_write_ms`: PDF・動画・音声をキャッシュのファイルへ書き出す時間
 * - `safe_to_load_start_ms`: 中身を渡してから WebView が読み込みを始めるまで（HTML の組み立て・描画・ネイティブへの受け渡しを含む）
 * - `safe_webview_load_ms`: WebView の読み込み開始〜完了（onLoadEnd。画像の data URI のデコードを含む）
 *
 * 結末（`safe_outcome`）は、表示できた `ok`、読み込みに失敗した `error`、表示し終える前に閉じた・
 * 読み直した `cancelled`。`cancelled` でも、そこまでに測れた区間は送る（待ちきれずに閉じた事例を拾うため）。
 */
export class FileViewerLoadTrace {
	private readonly startedAt: number;
	private readonly values: MobileTimingAttributes;
	private fetchedAt: number | undefined;
	private loadStartedAt: number | undefined;
	private finished = false;

	constructor(
		fetchKind: string,
		path: string,
		private readonly record: MobileTimingRecorder = recordMobileTiming,
		private readonly now: () => number = Date.now,
	) {
		this.startedAt = now();
		this.values = { safe_kind: fetchKind, safe_ext: timingExtension(path) };
	}

	/** PC の応答を受け取り、中身を画面へ渡す直前に呼ぶ。 */
	fetched(response: unknown): void {
		if (this.fetchedAt !== undefined || this.finished) {
			return;
		}
		this.fetchedAt = this.now();
		const requestId = fsResponseRequestId(response);
		if (requestId !== undefined) {
			this.values.safe_request_id = requestId;
		}
	}

	/** 画面がどの表示で出すか。最初の1回だけ記録する。 */
	viewing(viewer: string, mode: string): void {
		if (this.values.safe_viewer === undefined) {
			this.values.safe_viewer = viewer;
			this.values.safe_mode = mode;
		}
	}

	/** 表示用 HTML を組み立てた。最初の1回だけ記録する（表示の切り替えで作り直した分は数えない）。 */
	htmlBuilt(ms: number, chars: number): void {
		if (this.values.safe_html_build_ms === undefined) {
			this.values.safe_html_build_ms = ms;
			this.values.safe_html_chars = chars;
		}
	}

	/** PDF・動画・音声をキャッシュのファイルへ書き出した。 */
	fileWritten(ms: number): void {
		if (this.values.safe_file_write_ms === undefined) {
			this.values.safe_file_write_ms = ms;
		}
	}

	/** WebView の onLoadStart。 */
	readonly loadStarted = (): void => {
		if (this.loadStartedAt === undefined && this.fetchedAt !== undefined) {
			this.loadStartedAt = this.now();
		}
	};

	/** WebView の onLoadEnd。ここで表示し終えたとみなして送る。 */
	readonly loadEnded = (): void => {
		if (this.fetchedAt !== undefined) {
			this.finish('ok');
		}
	};

	/** 読み込みに失敗した。 */
	failed(): void {
		this.finish('error');
	}

	/** 閉じた・読み直した。表示し終えていれば何もしない。 */
	cancel(): void {
		this.finish('cancelled');
	}

	private finish(outcome: FileViewerLoadOutcome): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		const endedAt = this.now();
		const fetchedAt = this.fetchedAt;
		const loadStartedAt = this.loadStartedAt;
		this.record('mobileFileViewer', 'display', this.startedAt, endedAt, {
			...this.values,
			safe_outcome: outcome,
			safe_total_ms: endedAt - this.startedAt,
			...(fetchedAt !== undefined ? { safe_fetch_ms: fetchedAt - this.startedAt } : {}),
			...(fetchedAt !== undefined && loadStartedAt !== undefined ? { safe_to_load_start_ms: loadStartedAt - fetchedAt } : {}),
			...(loadStartedAt !== undefined && outcome === 'ok' ? { safe_webview_load_ms: endedAt - loadStartedAt } : {}),
		});
	}
}
