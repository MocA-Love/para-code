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
	 * ワークスペースの保存画面を書く。書く前に、環境変数のうちペイントークンなど fork の内部用の
	 * 値（{@link paradisIsSecretTerminalEnvKey}）とペイントークンを落とす。
	 */
	writeScreens(workspaceId: string, content: string): Promise<void>;
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
 * 保存画面に残してはいけない環境変数。fork がシェルへ渡す内部用の値（ペイントークン
 * `PARA_CODE_TERMINAL_PANE_ID`、`PARA_CODE_VOICE_TOKEN`、`PARA_CODE_CODEX_*` など）と、常駐の内部用
 * （`PARADIS_*`）。どれも PC を再起動した後には意味が無く、漏れたときの害だけが残る。
 */
export function paradisIsSecretTerminalEnvKey(key: string): boolean {
	return /^(PARA_CODE_|PARADIS_)/.test(key);
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
 * pty ホストの `serializeTerminalState` の結果から、内部用の環境変数とペイントークンを落とす。
 * 形が読めなければ例外（中身の分からないものは書かない）。
 */
export function paradisStripTerminalStateSecrets(serialized: string): string {
	const value = JSON.parse(serialized) as { state?: unknown };
	if (!value || typeof value !== 'object' || !Array.isArray(value.state)) {
		throw new Error('unexpected serialized terminal state');
	}
	for (const entry of value.state as Record<string, Record<string, unknown> | undefined>[]) {
		stripEnv(entry?.shellLaunchConfig?.env);
		stripEnv(entry?.processLaunchConfig?.env);
		stripEnv(entry?.processLaunchConfig?.executableEnv);
		if (entry?.processDetails) {
			delete entry.processDetails.paradisPaneToken;
		}
	}
	return JSON.stringify(value);
}
