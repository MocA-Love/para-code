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
 * 分類だけを返す。**ログ本文は決して返さない**: Sentryへ送る値は
 * `paradisSanitizeSentryText` を通るとはいえ、Codexのログに何が出るかはこちら側で
 * 制御できない（プロジェクトパス、プロンプト断片、リポジトリ名が混ざりうる）。
 * 許可リスト方式の分類IDだけを外へ出し、未知のものは 'unclassified' として件数だけ数える。
 */
export function paradisClassifyCodexPaneFailure(input: IParadisCodexPaneFailureInput): ParadisCodexPaneFailureKind {
	const text = input.log === undefined ? undefined : paradisStripCodexLogAnsi(input.log);
	if (text !== undefined && text.trim().length > 0) {
		for (const candidate of fatalPatterns) {
			if (candidate.pattern.test(text)) {
				return candidate.kind;
			}
		}
	}
	// 致命的な兆候が無いのにソケットが現れない場合、プロセスが生きていれば単に遅いだけ。
	if (input.serverAlive) {
		return 'server-alive';
	}
	if (text === undefined) {
		return 'no-log';
	}
	return text.trim().length === 0 ? 'log-empty' : 'unclassified';
}
