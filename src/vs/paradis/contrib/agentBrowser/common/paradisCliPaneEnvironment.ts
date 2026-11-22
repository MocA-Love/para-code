/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `para` コマンド（CLI）をペインから呼べるようにする環境変数。
//
// 手元のペイン: アプリの中の `resources/paradis/cli`（`para` と `para.cmd` だけが入ったフォルダ）を PATH の先頭に足し、
// CLI のスクリプトを Node.js として動かす実行ファイル（Para Code 自身）の場所を渡す。Codex のランチャーの
// フォルダ（`resources/paradis/bin`）とは分けてある。あちらは Windows では PATH に入れない決まりで
// （paradisPaneTokenService.ts の `_getCodexRuntime`）、`para` は Windows でも入れるため。
//
// SSH の接続先のペイン: 何も足さない。`para` は、Codex のランチャーと同じ `~/.para-code/bin`（もう PATH にある）へ
// 窓が置く（paradisRemoteAgentHooks.contribution.ts の `installParaCli`）。

/** CLI のスクリプトを Node.js として動かす実行ファイル（手元では Para Code 自身。ELECTRON_RUN_AS_NODE=1 で使う）。 */
export const PARADIS_CLI_NODE_ENV_VAR = 'PARA_CODE_CLI_NODE';

/** アプリの中のランチャーのフォルダ（appRoot から）。 */
export const PARADIS_CLI_LAUNCHER_FOLDER_SEGMENTS = ['resources', 'paradis', 'cli'] as const;
/** POSIX のランチャーの名前（接続先の `~/.para-code/bin` にも同じ名前で置く）。 */
export const PARADIS_CLI_LAUNCHER_NAME = 'para';
/** 接続先で、ランチャーの隣に置く行き先のファイル（1 行目: サーバーの node、2 行目: CLI のスクリプト）。 */
export const PARADIS_CLI_REMOTE_TARGET_NAME = 'para.target';
/** CLI のスクリプトの場所（appRoot から。手元でも接続先のサーバーでも同じ）。 */
export const PARADIS_CLI_SCRIPT_SEGMENTS = ['out', 'vs', 'paradis', 'contrib', 'agentBrowser', 'node', 'paradisCli.js'] as const;

export interface IParadisCliPaneRuntime {
	/** ランチャーのフォルダ（絶対パス）。 */
	readonly launcherDirectory: string;
	/** PATH の区切り（POSIX は `:`、Windows は `;`）。 */
	readonly pathDelimiter: string;
	/** Para Code の実行ファイル。分からなければ渡さない（ランチャーは PATH の node を使う）。 */
	readonly nodeExecutablePath?: string;
}

/**
 * ペインの環境変数へ `para` のランチャーのフォルダを足す。もう PATH が決まっていればその前に、決まっていなければ
 * ペインを開く側の PATH（`${env:PATH}`）の前に足す。シェルの統合が rc の後で付け直す `VSCODE_PATH_PREFIX` にも
 * 同じフォルダを足す（rc が PATH を組み直しても先頭に残る。Windows のシェルでは使われないので足さない）。
 *
 * Windows の環境変数の名前は大小文字を区別せず、多くは `Path` と書かれる。区切りが `;` のときは、もうある PATH の鍵を
 * 大小文字を無視して探し、その鍵に足す（`PATH` と `Path` を並べない）。
 *
 * `strictEnv` の端末（渡した環境変数だけで起動する。タスクや拡張機能が開く端末）では `${env:PATH}` が解決されない
 * （terminalEnvironment.ts の `createTerminalEnvironment`）。PATH が渡されていればその前に足し、渡されていなければ
 * PATH は足さない（解決されない文字列を PATH にしない）。
 */
export function paradisAddParaCliToPaneEnvironment(
	existing: Readonly<Record<string, string | null | undefined>> | undefined,
	runtime: IParadisCliPaneRuntime | undefined,
	strictEnv = false,
): Record<string, string | null | undefined> {
	const environment: Record<string, string | null | undefined> = { ...existing };
	if (runtime === undefined || runtime.launcherDirectory.length === 0 || runtime.pathDelimiter.length === 0) {
		return environment;
	}
	if (runtime.nodeExecutablePath !== undefined && runtime.nodeExecutablePath.length > 0) {
		environment[PARADIS_CLI_NODE_ENV_VAR] = runtime.nodeExecutablePath;
	}
	const prefix = `${runtime.launcherDirectory}${runtime.pathDelimiter}`;
	const windows = runtime.pathDelimiter === ';';
	const pathKey = (windows ? Object.keys(environment).find(key => key.toUpperCase() === 'PATH' && typeof environment[key] === 'string') : undefined) ?? 'PATH';
	const currentPath = environment[pathKey];
	if (typeof currentPath !== 'string' && strictEnv) {
		return environment;
	}
	environment[pathKey] = `${prefix}${typeof currentPath === 'string' ? currentPath : '${env:PATH}'}`;
	if (runtime.pathDelimiter === ':') {
		const currentPrefix = existing?.VSCODE_PATH_PREFIX;
		environment.VSCODE_PATH_PREFIX = `${prefix}${typeof currentPrefix === 'string' ? currentPrefix : ''}`;
	}
	return environment;
}

/** 接続先の行き先のファイルの中身。 */
export function paradisCliRemoteTargetContent(node: string, script: string): string {
	return `${node}\n${script}\n`;
}
