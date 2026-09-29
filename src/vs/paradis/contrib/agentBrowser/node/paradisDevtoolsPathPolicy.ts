/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵 chrome-devtools-mcp のツールへ渡る「手元のファイルを指す引数」を、誰から受けてよいかを決める
// （NOTES.md「chrome-devtools-mcp のファイルのパスは手元のペインからだけ受け、roots で範囲を絞る」）。
//
// chrome-devtools-mcp は手元（Para Code が動いている機械）の shared process の子プロセスとして動くので、
// ツール引数のパスは必ず手元のパスとして読み書きされる。接続先（SSH・WSL・コンテナ）のエージェントからの
// 呼び出しも戻り経路（ssh -R）を通って同じ子プロセスへ届くため、パスを通すと接続先から手元のファイルを
// 書ける（evaluate_script の filePath など）・読める（upload_file → ページ → evaluate_script）。
// そこで、接続先からの呼び出しではパスの引数（と `navigate_page` の `file:` の URL）を子プロセスへ渡す前に断る。
//
// 手元のペインからの呼び出しは通すが、子プロセスへ roots（ペインのスペースのフォルダ・一時フォルダ）を渡し、
// vendored の validatePath に範囲を確かめさせる（roots を渡さないと validatePath は何も確かめない）。

import { tmpdir } from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import { isAbsolute } from '../../../../base/common/path.js';
import { paradisIsLocalFileUrl } from './paradisCdpRemotePolicy.js';

/**
 * vendored chrome-devtools-mcp 1.5.0 のツールのうち、手元のファイル・フォルダを指す引数（各ツールの
 * `verifyFilesSchema` と同じ）。一覧に出ないツール（カテゴリが既定で無効なもの）も、将来有効に
 * なったときのために含めてある。vendored を更新したら `build/src/tools/*.js` の `verifyFilesSchema` と
 * 突き合わせること（加えて、名前が `path` で終わる引数は一覧に無くてもパスとして扱う）。
 */
export const PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
	['close_heapsnapshot', ['filePath']],
	['compare_heapsnapshots', ['baseFilePath', 'currentFilePath']],
	['evaluate_script', ['filePath']],
	['get_heapsnapshot_class_nodes', ['filePath']],
	['get_heapsnapshot_details', ['filePath']],
	['get_heapsnapshot_dominators', ['filePath']],
	['get_heapsnapshot_duplicate_strings', ['filePath']],
	['get_heapsnapshot_edges', ['filePath']],
	['get_heapsnapshot_retainers', ['filePath']],
	['get_heapsnapshot_retaining_paths', ['filePath']],
	['get_heapsnapshot_summary', ['filePath']],
	['get_network_request', ['requestFilePath', 'responseFilePath']],
	['install_extension', ['path']],
	['lighthouse_audit', ['outputDirPath']],
	['performance_start_trace', ['filePath']],
	['performance_stop_trace', ['filePath']],
	['screencast_start', ['filePath']],
	['take_heapsnapshot', ['filePath']],
	['take_screenshot', ['filePath']],
	['take_snapshot', ['filePath']],
	['upload_file', ['filePath']],
]);

/** 一覧に無い引数でも、名前が `path` で終わるものはパスとして扱う（vendored の更新で増えたときの保険）。 */
const PATH_LIKE_ARGUMENT = /path$/i;

/** roots に載せる手元のフォルダの上限。 */
const MAX_ROOT_FOLDERS = 16;

/**
 * 呼び出しの引数のうち、手元のファイル・フォルダを指すもの（値が渡されているもの）の名前を返す。
 * 値の型は見ない（空文字や null でも、vendored が受け付けるかどうかに関わらず断る側へ倒す）。
 * `navigate_page` の `url` は `file:` の URL のときだけ含める。
 */
export function paradisDevtoolsPathArguments(toolName: string, args: unknown): string[] {
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		return [];
	}
	const record = args as Record<string, unknown>;
	const known = new Set(PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS.get(toolName) ?? []);
	const found = new Set<string>();
	for (const key of Object.keys(record)) {
		if (record[key] !== undefined && (known.has(key) || PATH_LIKE_ARGUMENT.test(key))) {
			found.add(key);
		}
	}
	if (toolName === 'navigate_page' && paradisIsLocalFileUrl(record.url)) {
		found.add('url');
	}
	return [...found].sort();
}

/** 呼び出し元ペインについて、shared process が知っていること。 */
export interface IParadisDevtoolsPathCaller {
	/** ペインの台帳に載っているか。 */
	readonly paneKnown: boolean;
	/** 接続先（SSH・WSL・コンテナ）で動くペインか（`remoteAuthority` を持つ）、または戻り経路から来た呼び出しか。 */
	readonly remote: boolean;
}

export type ParadisDevtoolsPathDecision =
	| { readonly kind: 'forward' }
	| { readonly kind: 'refuse'; readonly message: string };

/** ツールごとの、パスを渡さずに呼んだときの案内。 */
const WITHOUT_PATH_HINTS: ReadonlyMap<string, string> = new Map([
	['take_screenshot', 'Without `filePath` the image is returned inline (a very large image is saved on the Para Code machine and the response tells you how to download it).'],
	['take_snapshot', 'Without `filePath` the snapshot is returned inline.'],
	['evaluate_script', 'Without `filePath` the result is returned inline.'],
	['get_network_request', 'Without `requestFilePath` / `responseFilePath` the bodies are returned inline.'],
	['performance_start_trace', 'Without `filePath` the trace summary and insights are returned inline; the raw trace file is not available from a remote window.'],
	['performance_stop_trace', 'Without `filePath` the trace summary and insights are returned inline; the raw trace file is not available from a remote window.'],
	['lighthouse_audit', 'Without `outputDirPath` the scores and failed audits are returned inline; the full report files stay on the Para Code machine.'],
	['upload_file', 'To give the page a file from your machine, use upload_file_to_drop_zone with the file content (`contentBase64`) instead.'],
	['take_heapsnapshot', 'take_heapsnapshot always writes a file, so it is not available to agents in a remote window.'],
	['navigate_page', 'Only http(s) and other non-file URLs can be opened from a remote window.'],
]);

/**
 * パスの引数を含む呼び出しを子プロセスへ渡してよいかを決める。
 * 接続先（SSH・WSL・コンテナ）のペイン・戻り経路から来た呼び出しは断る。ペインを特定できないときも断る（手元と確かめられないため）。
 * 手元のペインからは通す（範囲は子プロセスの roots で確かめる）。
 */
export function paradisDevtoolsPathDecision(caller: IParadisDevtoolsPathCaller, toolName: string, pathArguments: readonly string[]): ParadisDevtoolsPathDecision {
	if (pathArguments.length === 0) {
		return { kind: 'forward' };
	}
	const names = pathArguments.map(name => `\`${name}\``).join(', ');
	if (caller.remote) {
		const hint = WITHOUT_PATH_HINTS.get(toolName) ?? `Call ${toolName} again without ${names}; where the tool supports it, the result is returned inline.`;
		return {
			kind: 'refuse',
			message: `${toolName} was not run: ${names} would refer to the user's local machine (where Para Code runs), not to the machine this agent runs on, and Para Code does not accept local files from agents in a remote window (SSH, WSL, container). ${hint}`,
		};
	}
	if (!caller.paneKnown) {
		return {
			kind: 'refuse',
			message: `${toolName} was not run: Para Code could not identify the terminal pane this request comes from yet, so it does not accept file paths (${names}) for it. Retry in a few seconds, or call ${toolName} without ${names}.`,
		};
	}
	return { kind: 'forward' };
}

/**
 * 手元のペインの roots に足す、利用者の一時フォルダ（子プロセスの TMPDIR を差し替える前の `os.tmpdir()`。
 * macOS では `/tmp` と `/private/tmp` も）。エージェントがスクリーンショットなどを一時フォルダへ書くことは多い。
 */
export function paradisDevtoolsUserTemporaryFolders(platform: NodeJS.Platform = process.platform, temporaryDirectory: string = tmpdir()): string[] {
	return platform === 'darwin' ? [temporaryDirectory, '/tmp', '/private/tmp'] : [temporaryDirectory];
}

/** MCP の `roots/list` 応答の1件。 */
export interface IParadisDevtoolsRoot {
	readonly uri: string;
	readonly name: string;
}

/**
 * 子プロセスへ返す `roots/list` の中身。手元の絶対パスのフォルダ（重複を除き上限まで）と、Para Code の
 * 一時フォルダを載せる。接続先のペインにはフォルダを渡さず、一時フォルダだけになる。
 * 上限を超えて落としたフォルダがあれば `onOverflow` にその数を渡す。
 */
export function paradisDevtoolsRoots(folders: readonly string[], temporaryDirectory: string, onOverflow?: (dropped: number) => void): IParadisDevtoolsRoot[] {
	const roots: IParadisDevtoolsRoot[] = [];
	const seen = new Set<string>();
	let dropped = 0;
	for (const folder of folders) {
		if (typeof folder !== 'string' || !isAbsolute(folder) || seen.has(folder)) {
			continue;
		}
		seen.add(folder);
		if (roots.length >= MAX_ROOT_FOLDERS) {
			dropped++;
			continue;
		}
		roots.push({ uri: pathToFileURL(folder).href, name: 'workspace' });
	}
	if (dropped > 0) {
		onOverflow?.(dropped);
	}
	if (!seen.has(temporaryDirectory)) {
		roots.push({ uri: pathToFileURL(temporaryDirectory).href, name: 'Para Code temporary files' });
	}
	return roots;
}

/** vendored の validatePath が断ったときの文（`McpContext.js`）。 */
const ROOTS_DENIAL = /Access denied: path (?<path>.+?) \(canonical: .+?\) is not within any of the configured workspace roots\./g;

/**
 * vendored の validatePath に断られたツールの結果なら、許されている場所とパス無しで呼ぶ手を書いた文に
 * 置き換える（vendored の文は「workspace roots」とだけ言い、どこなら良いかが分からない）。
 * 該当しなければ `result` をそのまま返す。
 */
export function paradisDevtoolsExplainRootsDenial(result: unknown, roots: readonly IParadisDevtoolsRoot[]): unknown {
	const record = result as { isError?: unknown; content?: unknown } | undefined;
	if (record?.isError !== true || !Array.isArray(record.content)) {
		return result;
	}
	const folders = roots.map(root => {
		try {
			return fileURLToPath(root.uri);
		} catch {
			return root.uri;
		}
	});
	let changed = false;
	const content = record.content.map(part => {
		const text = (part as { type?: unknown; text?: unknown })?.text;
		if ((part as { type?: unknown })?.type !== 'text' || typeof text !== 'string' || !text.includes('is not within any of the configured workspace roots')) {
			return part;
		}
		changed = true;
		return {
			...(part as object),
			text: text.replace(ROOTS_DENIAL, (_match, path: string) =>
				`Access denied: ${path} is outside the folders the browser tools may read and write for this terminal pane. Allowed folders: ${folders.join(', ')}. Use a path inside one of them, or call the tool without the path argument to get the result inline where the tool supports it (take_screenshot, take_snapshot, evaluate_script, get_network_request).`),
		};
	});
	return changed ? { ...(result as object), content } : result;
}
