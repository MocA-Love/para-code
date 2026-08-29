/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office ビューア(Word/Excel の単体・差分)の表示失敗を Sentry へ送る入り口。
//
// ここでの約束事は、過去に本番データを引いて分かった落とし穴と、この経路の実装を実際に読んで
// 確かめた事実に対応している。**どれも「送っているつもりで届かない/読めない」に直結する。**
//
//  1. **渡した例外は Sentry に届かない。** `toParadisSentrySafeError`(paradisSentryDiagnostics.ts)が
//     capture の直前で error を捨て、`Para Code diagnostic: <feature>.<operation>` という合成 Error に
//     差し替え、stack も1行の文字列で上書きする(意図的な情報漏れ対策)。したがって
//     **理由は必ず `safe_` の extra 側に、こちらで畳んで載せること**。例外メッセージに書いても消える。
//  2. **operation に面(surface)を含める。** 指紋は
//     `scope|feature|operation|例外型|最上位フレームのファイル|関数`(paradisSentryFingerprint)だが、
//     1 のせいで例外型は常に `Error`、フレームは存在しない。**実効的な鍵は operation だけ**なので、
//     面を operation に入れないと4面が同じレートリミットの枠を共有してしまう。
//  3. **利用者から見た1回の失敗につき1件だけ送る。** レートリミッタは指紋ごと10分3件。
//     リカバリの梯子は remount→recreate→showError と3回まわるので、途中経過を送ると
//     **1つの文書が黙っただけで枠を使い切り**、以後10分間その面の失敗が無言で落ちる。
//     途中の観測は {@link ParadisOfficeFailureLatch} に溜め、終端で1件にまとめる。
//  4. **extra のキーは `safe_` 接頭辞**(または `isParadisSafeExtraKey` の allow-list)。
//     外すとサーバ側スクラブの部分一致に巻き込まれて黙って null で届く。
//  5. **span も custom measurement も使わない。** renderer(@sentry/browser)には非同期の
//     コンテキスト伝播が無く await を跨いだ子 span は独立 transaction になる。measurement は10個上限。
//  6. **タグで集計しない。** tag/context はプロセス内で共有される可変の袋で非同期作業へ漏れる。
//     Discover では operation 名で絞ること。

import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

/** どの面で起きたか。Discover でこの4値だけ見れば切り分けが済むようにしてある。 */
export type ParadisOfficeDiagnosticSurface = 'word-view' | 'word-diff' | 'excel-view' | 'excel-diff';

/** 有効だった処理エンジン。既定は `legacy`（設定 `paradis.officeViewer.enabled` が off のとき）。 */
export type ParadisOfficeDiagnosticEngine = 'legacy' | 'v1';

/** 時間切れがどこで起きたか。描画側が一度でも応答したかで、疑う場所が変わる。 */
export type ParadisOfficeDiagnosticStage =
	/** 文書の読み出し・解析が返ってこない（共有プロセス／ファイル読み出し側を疑う）。 */
	| 'source'
	/** 描画面は用意したが、描き終わりの報告が来ない（webview／描画側を疑う）。 */
	| 'render';

/** 利用者が「出なかった」と感じた直接の原因。1回の失敗につき1つだけ確定する。 */
export type ParadisOfficeFailureCause =
	/** 予算内に描き終わりの報告が来なかった。 */
	| 'timeout'
	/** 報告は来たが本文が空だった。 */
	| 'blank'
	/** 文書そのものを読めなかった／解析できなかった。 */
	| 'source'
	/** 左右は読めたが比較の計算で落ちた。 */
	| 'diff'
	/** 描画側から明示的なエラーが返った（表示用ライブラリ欠落など）。 */
	| 'render';

const FEATURE = 'office-viewers';

/**
 * セッション内の累計。**プロセス内の素朴なカウンタで十分**で、永続化はしない。
 * 知りたいのは「この面はよく失敗するのか、たまたま1回なのか」であって、生涯統計ではない。
 */
const opens = new Map<ParadisOfficeDiagnosticSurface, number>();
const failures = new Map<ParadisOfficeDiagnosticSurface, number>();

/** テストが互いのセッション累計を引き継がないようにするためだけの入り口。 */
export function resetParadisOfficeDiagnosticCounters(): void {
	opens.clear();
	failures.clear();
}

/** テストから累計を読むためだけの入り口。 */
export function readParadisOfficeDiagnosticCounters(surface: ParadisOfficeDiagnosticSurface): { readonly opens: number; readonly failures: number } {
	return { opens: opens.get(surface) ?? 0, failures: failures.get(surface) ?? 0 };
}

/**
 * 「利用者が1つの文書／比較を開いた」を1回数える。**送信はしない**（母数は失敗イベントに相乗りさせる）。
 *
 * 同じ入力での読み直しやタブの往復では増やさないこと。`EditorPane.setInput` は同じ入力へ戻る
 * たびに呼ばれるので、素朴に数えると**分母だけが膨らんで失敗率が実際より低く見える**。
 */
export function countParadisOfficeOpen(surface: ParadisOfficeDiagnosticSurface): void {
	opens.set(surface, (opens.get(surface) ?? 0) + 1);
}

/**
 * バイト数を粗い段階に畳む。
 *
 * 生のバイト数はファイルを言い当てる手掛かりになり得るし、そのままだと Sentry 側の
 * グルーピングも散らかる。知りたいのは「大きさが効いているか」だけなので段階で十分。
 */
function paradisOfficeByteBucket(totalBytes: number): string {
	if (!Number.isFinite(totalBytes) || totalBytes <= 0) { return 'unknown'; }
	if (totalBytes < 256 * 1024) { return '<256KB'; }
	if (totalBytes < 1024 * 1024) { return '256KB-1MB'; }
	if (totalBytes < 4 * 1024 * 1024) { return '1-4MB'; }
	if (totalBytes < 16 * 1024 * 1024) { return '4-16MB'; }
	return '16MB+';
}

/**
 * `FileOperationResult`(`vs/platform/files/common/files.ts`)の並び順に対応する名前。
 *
 * **数値のまま送ってはいけない。** upstream が列挙の途中にメンバを挿入すると、過去に送った
 * イベントの意味が黙って変わる。`const enum` なので実行時の逆引きオブジェクトが存在せず
 * （`FileOperationResult[n]` は書けない）、こちらで表を持つしかない。
 * 並びを変えたときはここも直すこと。範囲外の値は数値のまま出して、ズレに気づけるようにする。
 */
const FILE_OPERATION_RESULT_NAMES: readonly string[] = [
	'FILE_IS_DIRECTORY', 'FILE_NOT_FOUND', 'FILE_NOT_MODIFIED_SINCE', 'FILE_MODIFIED_SINCE',
	'FILE_MOVE_CONFLICT', 'FILE_WRITE_LOCKED', 'FILE_PERMISSION_DENIED', 'FILE_TOO_LARGE',
	'FILE_INVALID_PATH', 'FILE_NOT_DIRECTORY', 'FILE_OTHER_ERROR',
];

/**
 * 例外から、パスも利用者の内容も含まない識別子だけを取り出す。
 *
 * 例外そのものは Sentry へ届かない（冒頭 1）ので、**ここで畳んだものが唯一の手掛かりになる**。
 * `FileOperationError` は VS Code がファイル層の失敗理由を列挙で持っているので、その名前まで拾う
 * （`FILE_NOT_FOUND` / `FILE_TOO_LARGE` などが区別できると、原因の切り分けが一段速くなる）。
 * `message` は決して載せない — `IFileService` 由来の文言には対象のパスが入る。
 *
 * **`name` を見て `message` を見ない**のがこの関数の要点。種別を伝えたい呼び出し側は
 * `new Error('種別名')` ではなく観測の `code` に渡すこと（`new Error(x)` が設定するのは
 * `message` であって `name` ではないので、前者はここに届かず全部 `'Error'` になる）。
 */
function describeParadisOfficeError(error: unknown): { readonly safe_error_name: string; readonly safe_error_code?: string } {
	if (!(error instanceof Error)) {
		return { safe_error_name: typeof error };
	}
	const candidate = error as Error & { readonly fileOperationResult?: unknown };
	if (typeof candidate.fileOperationResult === 'number') {
		const name = FILE_OPERATION_RESULT_NAMES[candidate.fileOperationResult];
		return { safe_error_name: error.name, safe_error_code: name ?? `fileOperationResult:${candidate.fileOperationResult}` };
	}
	return { safe_error_name: error.name };
}

/** 終端で1件にまとめて送るための観測。 */
export interface IParadisOfficeFailureObservation {
	readonly cause: ParadisOfficeFailureCause;
	readonly stage?: ParadisOfficeDiagnosticStage;
	readonly side?: 'original' | 'modified' | 'both';
	/**
	 * 例外を持たない失敗の種別（表示用ライブラリの欠落など）。
	 * `new Error('種別名')` で代用しないこと — それが設定するのは `message` で、
	 * {@link describeParadisOfficeError} は `name` しか読まないため全部 `'Error'` になる。
	 */
	readonly code?: string;
	readonly error?: unknown;
	readonly elapsedMilliseconds?: number;
}

/**
 * 1回の失敗について観測を溜め、終端で1件だけ送る器。
 *
 * 途中経過を送らないのは、レートリミッタの枠を守るためだけではない。梯子の途中で見えるのは
 * 「作り直しても直らなかった」という同じ事実の繰り返しで、**別々のイベントにする意味が無い**。
 * 知りたいのは「最初に何が起きたか」と「何回試したか」で、それはこの器が持てる。
 */
export class ParadisOfficeFailureLatch {

	private first: IParadisOfficeFailureObservation | undefined;
	private attempts = 0;
	private reported = false;

	constructor(private readonly surface: ParadisOfficeDiagnosticSurface) { }

	/**
	 * 観測を1つ記録する。**最初のものが原因として残る**（作り直しの結果ではなく、
	 * 最初に何が起きたかが知りたいため）。試行回数だけは毎回進む。
	 *
	 * 梯子を1周するごとにちょうど1回呼ぶこと。時間切れ側だけ呼んで白紙側で呼ばないと、
	 * 同じ3周でも `attempt` が 4 と 1 になり、値の意味が原因によって変わってしまう。
	 */
	note(observation: IParadisOfficeFailureObservation): void {
		this.attempts++;
		this.first ??= observation;
	}

	/** 新しい表示を始める。前の失敗の記録は捨てる。 */
	reset(): void {
		this.first = undefined;
		this.attempts = 0;
		this.reported = false;
	}

	/** 何か記録されているか（終端で送るものがあるか）。 */
	get hasObservation(): boolean {
		return this.first !== undefined;
	}

	/**
	 * 溜めた観測を1件だけ送る。二度目以降は何もしない。
	 *
	 * 呼ぶのは**利用者が失敗を目にする場所**だけ（梯子を使い切った `showError`、または
	 * 戻す先が無い `sourceUnavailable`）。途中で呼ぶと 1 回の失敗が複数件になる。
	 */
	report(engine: ParadisOfficeDiagnosticEngine, totalBytes: number): void {
		const observation = this.first;
		if (this.reported || !observation) {
			return;
		}
		this.reported = true;
		const failureCount = (failures.get(this.surface) ?? 0) + 1;
		failures.set(this.surface, failureCount);
		reportParadisDiagnosticError(
			'owned', FEATURE,
			// 面を operation に入れる理由は冒頭 2 を参照。ここを縮めると4面が同じ枠を食い合う。
			`failed:${this.surface}`,
			new Error(`Office ${this.surface} failed to display (${observation.cause})`),
			{
				safe_surface: this.surface,
				safe_engine: engine,
				safe_bytes: paradisOfficeByteBucket(totalBytes),
				safe_cause: observation.cause,
				// 梯子を何回まわったか。1回目で必ず落ちるのか、作り直しで直ることがあるのかが分かれる。
				attempt: this.attempts,
				safe_opens: opens.get(this.surface) ?? 0,
				safe_failures: failureCount,
				...(observation.stage ? { safe_stage: observation.stage } : {}),
				...(observation.side ? { safe_side: observation.side } : {}),
				...(observation.elapsedMilliseconds !== undefined ? { duration_ms: observation.elapsedMilliseconds } : {}),
				...(observation.code !== undefined ? { safe_error_code: observation.code } : {}),
				...(observation.error !== undefined ? describeParadisOfficeError(observation.error) : {}),
			},
		);
	}
}
