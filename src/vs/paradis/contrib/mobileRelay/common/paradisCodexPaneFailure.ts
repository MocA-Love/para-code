/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ペインのCodex app-serverが立ち上がらなかった理由の分類。
 *
 * ランチャー（`resources/paradis/bin/codex` と `paradisCodexPaneLauncher.cjs`）は
 * app-serverの出力を `<socket>.log` に書き、起動できなければ素のCodexへフォールバックする。
 * フォールバックするとユーザーは困らなくなる＝症状が見えなくなるので、Sentryが唯一の
 * 検知手段になる。ところが従来は `pathExists()` の真偽しか見ておらず「10秒経ってもソケットが
 * 無い」しか送れていなかった。答えはソケットの隣のログに書いてあるので、それを読んで分類する。
 */
export type ParadisCodexPaneFailureKind =
	/** ディスク不足。state runtimeの初期化失敗として現れることが多いので先に判定する。 */
	| 'disk-full'
	/** CODEX_HOME配下への権限不足。 */
	| 'permission'
	/** Codex本体やvendorバイナリが見つからない（壊れたインストール）。 */
	| 'exec-missing'
	/** 待ち受けポートの衝突（Windows方式のみ発生しうる）。 */
	| 'port-in-use'
	/** config.tomlが壊れている。 */
	| 'config'
	/** 再ログインが必要。 */
	| 'auth'
	/** `~/.codex` のsqliteステートを開けない。実地で観測された主因。 */
	| 'state-runtime'
	/** プロセスは生きている＝単に起動が遅い。障害ではない。 */
	| 'server-alive'
	/**
	 * ソケットは在るが、記録された持ち主のプロセスが死んでいる＝後片付け漏れの死骸。
	 *
	 * ログ本文からではなく接続前の生存判定から与えられる唯一の種別で、他と違って
	 * `classify` は返さない。ログには前世代の内容が残っているため、ここを分類に任せると
	 * 原因判明済みの事象が `unclassified` を埋め、古い行の `auth` 等を誤報する。
	 */
	| 'stale-socket'
	/** ログファイルそのものが無い＝ランチャーが起動を試みた形跡すら無い。 */
	| 'no-log'
	/** ログはあるが空＝起動直後で、まだ何も出力していない。 */
	| 'log-empty'
	/** ログはあるが既知パターンに当たらない。増えてきたらパターンを追加する。 */
	| 'unclassified';

export interface IParadisCodexPaneFailureInput {
	/** `<socket>.log` の末尾。ファイルが無い場合のみ undefined。 */
	readonly log: string | undefined;
	/** app-serverのプロセスがまだ生きているか。 */
	readonly serverAlive: boolean;
}

/** ログ末尾から読む最大バイト数。Codexのログは無制限に伸びるので必ず上限を掛ける。 */
export const PARADIS_CODEX_PANE_LOG_TAIL_BYTES = 8_192;

/**
 * 致命的な失敗だけを表すパターン。順序は「より根本的な原因」が先。
 *
 * 正常に何時間も動いていたapp-serverのログにも
 * `ERROR codex_models_manager::cache: failed to load models cache: missing field ...` や
 * `failed to renew cache TTL: ...` が大量に出る（実機のログで確認済み）。したがって
 * 「ERRORという語がある」「failedという語がある」だけで失敗と見なしてはならず、
 * 起動を妨げる事象だけを名指しする。
 */
const fatalPatterns: ReadonlyArray<{ readonly kind: ParadisCodexPaneFailureKind; readonly pattern: RegExp }> = [
	{ kind: 'disk-full', pattern: /\bENOSPC\b|no space left|disk (?:is )?full/i },
	{ kind: 'permission', pattern: /\bEACCES\b|\bEPERM\b|permission denied/i },
	{ kind: 'exec-missing', pattern: /\bENOENT\b|command not found|missing optional dependency/i },
	{ kind: 'port-in-use', pattern: /\bEADDRINUSE\b|address (?:already )?in use/i },
	{ kind: 'config', pattern: /failed to (?:parse|load|read) config(?:uration|\.toml)?\b|invalid config/i },
	{ kind: 'auth', pattern: /\bunauthorized\b|not logged in|re-?login|authentication (?:failed|required)|token (?:has been )?invalidated/i },
	{ kind: 'state-runtime', pattern: /failed to initialize (?:sqlite )?state runtime|failed to initialize state runtime/i },
];

/**
 * CSI/OSCエスケープを除去する。Codexのログは色付きで出るため、素朴なマッチだと
 * 単語の途中にエスケープが挟まって取りこぼす。
 */
export function paradisStripCodexLogAnsi(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * 分類が「今回の起動の話」なのかを判断するための材料。
 *
 * ログは**新しく app-server を起動するときは truncate される**（`resources/paradis/bin/codex` が
 * `: > "$log_path"`、ランチャーが `flags: 'w'`）。積み上がるのは既存サーバを再利用した分岐だけ。
 * したがって「一致箇所が末尾から遠い」の意味は `serverAlive` で変わる:
 *  - `serverAlive: false`（サーバは死んでいる）… そのログはその世代のもの。距離が遠くても
 *    起動時の失敗を指している可能性が高い
 *  - `serverAlive: true`（再利用中）… 何時間も前の行を拾っている疑いが濃い。`auth` と
 *    報告していても、実際は「起動が遅いだけ」かもしれない
 *
 * ローカルの実ログ16本では致命パターンに1件も当たらなかった（＝健全なログへの誤爆は無い）が、
 * 別の機体で古い行に当たっている可能性はそれでは否定できないので、本番で測る。
 */
export interface IParadisCodexPaneFailureEvidence {
	/** 一致した種別。致命パターンに当たらなかった場合は undefined。 */
	readonly kind: ParadisCodexPaneFailureKind | undefined;
	/** 一致箇所がログ末尾から何文字手前か。小さいほど「今まさに起きた」に近い。 */
	readonly distanceFromEnd: number | undefined;
	/**
	 * 判定に使った文字数（ANSI除去後）。**{@link distanceFromEnd} と同じ座標系の分母**。
	 * 生バイト数で割ると、除去したエスケープのぶんだけ比率が狂う。
	 * 読み取り上限に張り付いていれば「タイルが満杯＝古い行がありうる」とも読める。
	 */
	readonly textLength: number;
	/** ログはあるが空白しかない。 */
	readonly blank: boolean;
}

/**
 * 分類とあわせて、その根拠がどこにあったかを返す。
 *
 * {@link paradisClassifyCodexPaneFailure} は**この関数の上に組み立てる**こと。
 * 同じ配列を2回舐める書き方にすると「判定順序を揃える」が規約頼みになり、
 * 将来どちらかだけ直されたときに Sentry 上で種別と距離が食い違う。
 */
export function paradisInspectCodexPaneFailure(input: IParadisCodexPaneFailureInput): IParadisCodexPaneFailureEvidence {
	const text = input.log === undefined ? undefined : paradisStripCodexLogAnsi(input.log);
	if (text === undefined) {
		return { kind: undefined, distanceFromEnd: undefined, textLength: 0, blank: false };
	}
	const blank = text.trim().length === 0;
	if (!blank) {
		for (const candidate of fatalPatterns) {
			const match = candidate.pattern.exec(text);
			if (match) {
				return { kind: candidate.kind, distanceFromEnd: text.length - match.index, textLength: text.length, blank };
			}
		}
	}
	return { kind: undefined, distanceFromEnd: undefined, textLength: text.length, blank };
}

/**
 * 分類だけを返す。**ログ本文は決して返さない**: Sentryへ送る値は
 * `paradisSanitizeSentryText` を通るとはいえ、Codexのログに何が出るかはこちら側で
 * 制御できない（プロジェクトパス、プロンプト断片、リポジトリ名が混ざりうる）。
 * 許可リスト方式の分類IDだけを外へ出し、未知のものは 'unclassified' として件数だけ数える。
 */
export function paradisClassifyCodexPaneFailure(input: IParadisCodexPaneFailureInput): ParadisCodexPaneFailureKind {
	const evidence = paradisInspectCodexPaneFailure(input);
	if (evidence.kind !== undefined) {
		return evidence.kind;
	}
	// 致命的な兆候が無いのにソケットが現れない場合、プロセスが生きていれば単に遅いだけ。
	if (input.serverAlive) {
		return 'server-alive';
	}
	if (input.log === undefined) {
		return 'no-log';
	}
	return evidence.blank ? 'log-empty' : 'unclassified';
}
