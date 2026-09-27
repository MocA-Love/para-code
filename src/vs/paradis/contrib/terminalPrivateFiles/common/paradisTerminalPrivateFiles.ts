/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの画面を含むファイル（常駐の保存画面 TM14、描画ずれの記録 TM12）を、main プロセスで
// 本人だけが読める権限（フォルダ 0700 / ファイル 0600）で読み書きする口。
//
// renderer の IFileService では権限を指定できず、既定の 0644 で書かれる。画面には秘密情報が
// 写りうるうえ、保存画面には環境変数も入るので、書き込みは main（node の fs）に寄せる。

export const PARADIS_TERMINAL_PRIVATE_FILES_CHANNEL = 'paradisTerminalPrivateFiles';

/** 描画ずれの記録1件。画像は PNG の base64（data URL の本体）。 */
export interface IParadisRenderEvidence {
	readonly beforePng?: string;
	readonly afterPng?: string;
	/** info.json の中身。 */
	readonly info: string;
}

export interface IParadisTerminalPrivateFiles {
	/** ワークスペースの保存画面を読む。無ければ undefined。 */
	readScreens(workspaceId: string): Promise<string | undefined>;
	/**
	 * ワークスペースの保存画面を書く。`state` は pty ホストの `serializeTerminalState` の結果で、
	 * 書く前に秘密の値を落とす（{@link paradisStripTerminalStateSecrets}）。
	 */
	writeScreens(workspaceId: string, savedAt: number, daemon: { readonly pid: number; readonly startedAt: number }, state: string): Promise<void>;
	deleteScreens(workspaceId: string): Promise<void>;
	/** 指定より古い保存画面を全ワークスペースぶん消す。 */
	sweepScreens(maxAge: number): Promise<void>;
	/** 描画ずれの記録を1件書く（古いもの・期限切れを消してから）。書いたフォルダのパスを返す。 */
	writeRenderEvidence(evidence: IParadisRenderEvidence): Promise<string | undefined>;
}

/** ワークスペース ID として受け付ける形（ファイル名になるので、パスを組み立てられる文字は通さない）。 */
export function paradisIsSafeWorkspaceId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * 保存画面に残してはいけない環境変数（許可リストではなく、落とすものを名指しする）。
 *
 * ペイントークンとそこから作る Codex app-server の置き場所、音声のトークン、常駐の内部用の値。
 * どれも PC を再起動した後には意味が無く（ペイン用の値は復元のときに付け直す）、漏れたときの害
 * だけが残る。スペース別の履歴（`PARA_CODE_SPACE_HISTORY_*`）や MCP のポートファイルのように、
 * 秘密ではなく、起こし直したシェルにも要るものは残す。
 */
export function paradisIsSecretTerminalEnvKey(key: string): boolean {
	return key === 'PARA_CODE_TERMINAL_PANE_ID'
		|| key === 'PARA_CODE_VOICE_TOKEN'
		|| key.startsWith('PARA_CODE_CODEX_APP_SERVER_')
		|| key.startsWith('PARADIS_PTY_');
}

function stripEnv(env: unknown): void {
	if (env && typeof env === 'object') {
		for (const key of Object.keys(env)) {
			if (paradisIsSecretTerminalEnvKey(key)) {
				delete (env as Record<string, unknown>)[key];
			}
		}
	}
}

/**
 * pty ホストの `serializeTerminalState` の結果から秘密の値を落とす。形が読めなければ例外
 * （中身の分からないものは書かない）。
 *
 * - `shellLaunchConfig.env`: 秘密の変数だけ落とす（upstream は復元のときにここから環境変数を
 *   作り直すので、スペース別の履歴などは残す必要がある）
 * - `processLaunchConfig.env`: 空にする。起動元から引き継いだ全環境変数（API キーなど）が入って
 *   いるが、upstream は復元のときに作り直すので要らない
 * - `processLaunchConfig.executableEnv`: 実行ファイルを探すのに使われるので残し、秘密の変数だけ落とす
 * - `processDetails.paradisPaneToken`: 落とす
 *
 * シェル統合の nonce は残る（エディタのタブと起こし直した端末を結び付けるのに要る）。
 * ペイントークンは nonce から決まるので、**このファイルを読めればペイントークンも分かる**。
 * そのためファイルは本人だけが読める権限で書く。
 */
export function paradisStripTerminalStateSecrets(serialized: string): string {
	const value = JSON.parse(serialized) as { state?: unknown };
	if (!value || typeof value !== 'object' || !Array.isArray(value.state)) {
		throw new Error('unexpected serialized terminal state');
	}
	for (const entry of value.state as Record<string, Record<string, unknown> | undefined>[]) {
		stripEnv(entry?.shellLaunchConfig?.env);
		if (entry?.processLaunchConfig) {
			entry.processLaunchConfig.env = {};
			stripEnv(entry.processLaunchConfig.executableEnv);
		}
		if (entry?.processDetails) {
			delete entry.processDetails.paradisPaneToken;
		}
	}
	return JSON.stringify(value);
}
