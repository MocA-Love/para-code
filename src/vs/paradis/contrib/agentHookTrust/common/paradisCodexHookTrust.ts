/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex の hook の信頼を Para Code が代わりに付けるための共有定義。
//
// Codex は hooks.json の hook を使う前に、利用者の「信頼する」を求める。信頼は
// `<CODEX_HOME>/config.toml` の `[hooks.state."<hooks.json>:<イベント>:<定義の位置>:<hookの位置>"]`
// に `trusted_hash = "<Codex が計算したハッシュ>"` として残る。ハッシュの計算方法は Codex の内部仕様で
// 版ごとに変わりうるので、こちらでは計算しない。`codex app-server` の `hooks/list` が返す
// `currentHash` をそのまま `config/batchWrite` で書き戻す（Codex の TUI の「Trust all」と同じ経路）。
//
// 対象は Para Code が置いた hook だけ。判定は「その CODEX_HOME の hooks.json にある」「利用者の層
// (`source: user`) から来ている」「コマンドが Para Code の書く文字列と完全に一致する」の3つ。
// 利用者自身の hook は、同じファイルにあっても一切触らない。

export const PARADIS_CODEX_HOOK_TRUST_CHANNEL = 'paradisCodexHookTrust';

/**
 * SSH の接続先（REH）で、接続先の CODEX_HOME の Para Code の hook に信頼を付けるチャネル
 * （node/paradisRemoteCodexHookTrust.server.ts）。接続先では codex を起こせるとは限らないので、
 * Codex と同じ計算でハッシュを作って config.toml を直接書く（node/paradisCodexHookTrustFile.ts）。
 * 呼ぶのはウィンドウ側で、`getStatus` / `grant` / `listCodexHomes` とも引数を取らない（扱うホームは接続先が決める）。
 */
export const PARADIS_REMOTE_CODEX_HOOK_TRUST_CHANNEL = 'paradisRemoteCodexHookTrust';

/** 手元と接続先の hook の信頼と、接続先からの戻り経路の状態を出すコマンド（設定ダイアログの「状態を確認…」）。 */
export const PARADIS_SHOW_CODEX_HOOK_STATUS_COMMAND_ID = 'paradis.agentHooks.showCodexHookStatus';

/**
 * 信頼の付け方の設定。
 * - `ask`: まだ聞いていない（既定）。信頼が要る hook を見つけたら、一度だけ利用者に確かめる
 * - `auto`: 確かめ済み。以後は Para Code が設置し直すたびに自動で信頼を付ける
 * - `off`: 付けない（Codex の画面で利用者が自分で信頼する）
 */
export const PARADIS_CODEX_HOOK_TRUST_SETTING = 'paradis.agentHooks.codexTrust';

export type ParadisCodexHookTrustMode = 'ask' | 'auto' | 'off';

/**
 * 設定値を読む。shared process にはスキーマ（既定値）が無いので未設定は undefined で届く。
 * 知らない値も `ask` として扱う（黙って信頼を付ける側へは倒さない）。
 */
export function paradisCodexHookTrustMode(value: unknown): ParadisCodexHookTrustMode {
	return value === 'auto' || value === 'off' ? value : 'ask';
}

/** `hooks/list` の1件のうち、ここで使うところ。 */
export interface IParadisCodexHookListing {
	/** Codex が信頼の記録に使う鍵（そのまま `hooks.state` の鍵になる）。 */
	readonly key: string;
	readonly eventName: string;
	/** `untrusted` / `trusted` / `modified` / `managed`。 */
	readonly trustStatus: string;
	/** Codex が計算した今のハッシュ。信頼を付けるときはこれを `trusted_hash` に書く。 */
	readonly currentHash: string;
}

export interface IParadisCodexHookTrustStatus {
	/** 対象の CODEX_HOME。 */
	readonly codexHome: string;
	/** 対象の hooks.json。 */
	readonly hooksPath: string;
	/** codex が見つかり、`hooks/list` に答えたか。 */
	readonly supported: boolean;
	/** Para Code が置いた hook のうち、まだ信頼されていないもの。 */
	readonly pending: readonly IParadisCodexHookListing[];
	/** Para Code が置いた hook の総数。 */
	readonly managedCount: number;
	/** 調べられなかった理由（ログ用。利用者にはそのまま見せない）。 */
	readonly error?: string;
}

export type ParadisCodexHookTrustOutcome =
	/** 信頼を付けて、付いたことを確かめた。 */
	| 'granted'
	/** もともと全部信頼されていた（何も書いていない）。 */
	| 'already-trusted'
	/** Para Code の hook がその hooks.json に無い。 */
	| 'nothing-installed'
	/** codex が無い・古くて必要な RPC が無い。 */
	| 'unsupported'
	/** 書いたあとの確認が合わなかったので、書く前の config.toml へ戻した。 */
	| 'verify-failed'
	/** 途中で失敗した（書いていれば元へ戻した）。 */
	| 'failed'
	/** 設定が `auto` ではないので何もしなかった（自動の経路だけ）。 */
	| 'skipped';

export interface IParadisCodexHookTrustGrantResult {
	readonly outcome: ParadisCodexHookTrustOutcome;
	readonly codexHome: string;
	readonly hooksPath: string;
	/** 今回信頼を付けた hook のイベント名。 */
	readonly grantedEvents: readonly string[];
	readonly detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeForCompare(path: string, isWindows: boolean): string {
	return isWindows ? path.replace(/\\/g, '/').toLowerCase() : path;
}

/**
 * `hooks/list` の応答から、Para Code が置いた hook だけを取り出す（同じ鍵は1回だけ）。
 *
 * @param hooksPaths 対象 hooks.json として認める表記。Codex は CODEX_HOME を実体パスへ直して答えるので、
 *   「実体の CODEX_HOME + hooks.json」と「hooks.json 自体の実体パス」（symlink のとき）を渡す
 * @param managedCommand Para Code が hooks.json に書くコマンド文字列（完全一致で判定する）
 */
export function paradisSelectManagedCodexHooks(listResult: unknown, hooksPaths: readonly string[], managedCommand: string, isWindows: boolean): IParadisCodexHookListing[] {
	const data = isRecord(listResult) && Array.isArray(listResult.data) ? listResult.data : [];
	const expectedPaths = new Set(hooksPaths.map(path => normalizeForCompare(path, isWindows)));
	const seen = new Set<string>();
	const result: IParadisCodexHookListing[] = [];
	for (const entry of data) {
		const hooks = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
		for (const hook of hooks) {
			if (!isRecord(hook)
				|| typeof hook.key !== 'string'
				|| typeof hook.currentHash !== 'string'
				|| typeof hook.trustStatus !== 'string'
				|| typeof hook.sourcePath !== 'string'
				|| hook.source !== 'user'
				|| hook.handlerType !== 'command'
				|| hook.command !== managedCommand
				|| !expectedPaths.has(normalizeForCompare(hook.sourcePath, isWindows))
				|| seen.has(hook.key)) {
				continue;
			}
			seen.add(hook.key);
			result.push({
				key: hook.key,
				eventName: typeof hook.eventName === 'string' ? hook.eventName : '',
				trustStatus: hook.trustStatus,
				currentHash: hook.currentHash,
			});
		}
	}
	return result;
}

/** 信頼を付ける必要があるか（未確認か、中身が変わって信頼が外れたもの）。 */
export function paradisCodexHookNeedsTrust(listing: IParadisCodexHookListing): boolean {
	return listing.trustStatus === 'untrusted' || listing.trustStatus === 'modified';
}
