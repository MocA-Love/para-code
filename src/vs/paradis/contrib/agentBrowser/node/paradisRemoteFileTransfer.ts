/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（SSH・WSL・コンテナ）のペインのエージェントが、ブラウザのツールにファイルのパスを渡したときの
// shared process 側。ツールは手元で動くので、手元の一時ファイルで動かし、中身だけを接続先と受け渡す
// （受け渡しは呼び出し元ペインを所有するウィンドウの IFileService。取り決めは common/paradisRemoteFileBridge.ts）。
//
//  - take_screenshot / take_snapshot の `filePath`: 手元の一時フォルダへ書かせ、接続先のそのパスへ書き戻す
//  - upload_file の `filePath`: 接続先のファイルを読み、手元の一時ファイルにして渡す（ページが後から読むので
//    すぐには消さず、一定時間後に消す）
//  - save_page_as_pdf / download_by_click: 手元のダウンロードフォルダに保存したものを、接続先のホームの `.para-code/browser-files` へ写す
//
// 一時ファイルは内蔵 chrome-devtools-mcp の一時フォルダ（子プロセスの roots。0700）の下に作る。

import { promises as fs } from 'fs';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { basename, extname, join } from '../../../../base/common/path.js';
import { ParadisMcpOwningWindowResult } from '../common/paradisMcpToolProvider.js';
import {
	ParadisRemoteFileCheckResult,
	ParadisRemoteFileFailure,
	ParadisRemoteFileReadResult,
	ParadisRemoteFileWriteResult,
	PARADIS_REMOTE_FILE_CHECK_WRITE_METHOD,
	PARADIS_REMOTE_FILE_MAX_BYTES,
	PARADIS_REMOTE_FILE_MAX_BYTES_LABEL,
	PARADIS_REMOTE_FILE_USER_FOLDER,
	PARADIS_REMOTE_FILE_READ_METHOD,
	PARADIS_REMOTE_FILE_WRITE_METHOD,
	PARADIS_REMOTE_FILE_WRITE_TEMPORARY_METHOD,
	paradisNormalizeRemoteFilePath,
	paradisReplaceRemoteFileExtension,
} from '../common/paradisRemoteFileBridge.js';
import { PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS } from './paradisDevtoolsPathPolicy.js';
import { ParadisFileDropStaging, paradisSanitizeFileDropName } from './paradisFileDropUpload.js';

/** upload_file の一時ファイルを残す時間。ページはファイルを選んだ後で読む（送信時など）ので、すぐには消さない。 */
const UPLOAD_STAGING_TTL_MS = 30 * 60_000;
const UPLOAD_STAGING_MAX_ENTRIES = 16;
const UPLOAD_STAGING_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** 接続先とのファイルの受け渡しが要るツールと、その向き。 */
type ParadisRemoteFileDirection = 'output' | 'input';

const REMOTE_FILE_TOOLS: ReadonlyMap<string, ParadisRemoteFileDirection> = new Map([
	['take_screenshot', 'output'],
	['take_snapshot', 'output'],
	['upload_file', 'input'],
]);

/**
 * 接続先のペインからのこの呼び出しを、ファイルの受け渡しで動かせるか。パスの引数が `filePath` だけのときに限る
 * （他のパスの引数は今までどおり断る）。
 */
export function paradisRemoteFileToolDirection(toolName: string, pathArguments: readonly string[]): ParadisRemoteFileDirection | undefined {
	const direction = REMOTE_FILE_TOOLS.get(toolName);
	return direction !== undefined && pathArguments.length === 1 && pathArguments[0] === 'filePath' ? direction : undefined;
}

/** 接続先のペインへ返す `initialize` の `instructions` に足す説明。 */
export const PARADIS_REMOTE_PANE_FILE_INSTRUCTIONS = 'This terminal pane runs on a remote machine (SSH, WSL, container) while the browser runs on the machine of Para Code. File paths you give to take_screenshot, take_snapshot and upload_file (`filePath`) and to preview_file (`path`) are absolute paths on YOUR machine: Para Code copies the file between your machine and the browser (up to ' + PARADIS_REMOTE_FILE_MAX_BYTES_LABEL + '). It writes only inside the folder of this pane\'s space or ~/' + PARADIS_REMOTE_FILE_USER_FOLDER + ' (never into .git, .hg or .svn), and reads from those or the system temporary folder. save_page_as_pdf and download_by_click save on the Para Code machine and also copy the file to ~/' + PARADIS_REMOTE_FILE_USER_FOLDER + ' on your machine (copies older than a day are removed); the response tells you that path. Other path arguments (for example evaluate_script `filePath`, performance traces, lighthouse_audit `outputDirPath`) are not available here; omit them to get results inline.';

const REMOTE_OUTPUT_PATH_DESCRIPTION = `Absolute path on the machine this agent runs on (not the Para Code machine), inside the folder of this terminal pane's space or ~/${PARADIS_REMOTE_FILE_USER_FOLDER} (not /tmp, not inside .git/.hg/.svn). Para Code writes the file there (up to ${PARADIS_REMOTE_FILE_MAX_BYTES_LABEL}); relative paths are not accepted.`;
const REMOTE_INPUT_PATH_DESCRIPTION = `Absolute path of a file on the machine this agent runs on (not the Para Code machine), inside the folder of this terminal pane's space, ~/${PARADIS_REMOTE_FILE_USER_FOLDER} or the system temporary folder (for example /tmp), up to ${PARADIS_REMOTE_FILE_MAX_BYTES_LABEL}. Para Code reads it and gives it to the page; relative paths are not accepted.`;
const REMOTE_UNAVAILABLE_PATH_DESCRIPTION = 'Not available to agents in a remote window (SSH, WSL, container): this path would be on the machine running Para Code. Omit it; where the tool supports it the result is returned inline.';
const REMOTE_PREVIEW_PATH_DESCRIPTION = 'Absolute path of the file on the machine this agent runs on (relative paths are rejected because this server does not share your working directory).';
const REMOTE_SAVED_FILE_NOTE = ` From this terminal pane (a remote machine) the file is also copied to ~/${PARADIS_REMOTE_FILE_USER_FOLDER} on your machine (up to ${PARADIS_REMOTE_FILE_MAX_BYTES_LABEL}), and the response gives that path.`;

interface IParadisDescribedTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
}

/** 入力の説明を差し替えたツールの定義（元の定義は変えない）。 */
function withPropertyDescriptions<T extends IParadisDescribedTool>(tool: T, descriptions: ReadonlyMap<string, string>): T {
	const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
	const properties = schema?.properties;
	if (properties === undefined || typeof properties !== 'object') {
		return tool;
	}
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(properties)) {
		const description = descriptions.get(key);
		if (description !== undefined && value !== null && typeof value === 'object') {
			next[key] = { ...(value as object), description };
			changed = true;
		} else {
			next[key] = value;
		}
	}
	return changed ? { ...tool, inputSchema: { ...(schema as object), properties: next } } : tool;
}

/**
 * 接続先のペインへ返すツールの一覧。パスの引数の説明を「エージェントの機械のパス」「使えない」に書き換える
 * （vendored の説明は「current working directory からの相対パス」で、手元のパスとして読まれる）。
 */
export function paradisDescribeToolsForRemotePane<T extends IParadisDescribedTool>(tools: readonly T[]): T[] {
	return tools.map(tool => {
		const direction = REMOTE_FILE_TOOLS.get(tool.name);
		if (direction !== undefined) {
			return withPropertyDescriptions(tool, new Map([['filePath', direction === 'output' ? REMOTE_OUTPUT_PATH_DESCRIPTION : REMOTE_INPUT_PATH_DESCRIPTION]]));
		}
		const pathArguments = PARADIS_DEVTOOLS_LOCAL_PATH_ARGUMENTS.get(tool.name);
		if (pathArguments !== undefined) {
			return withPropertyDescriptions(tool, new Map(pathArguments.map(name => [name, REMOTE_UNAVAILABLE_PATH_DESCRIPTION])));
		}
		if (tool.name === 'preview_file') {
			return withPropertyDescriptions(tool, new Map([['path', REMOTE_PREVIEW_PATH_DESCRIPTION]]));
		}
		if ((tool.name === 'save_page_as_pdf' || tool.name === 'download_by_click') && typeof tool.description === 'string') {
			return { ...tool, description: `${tool.description}${REMOTE_SAVED_FILE_NOTE}` };
		}
		return tool;
	});
}

/** ツールの結果の本文にある `from` を `to` へ置き換える（手元の一時ファイルのパスを接続先のパスに見せる）。 */
export function paradisReplacePathInToolResult(result: unknown, from: string, to: string): unknown {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content) || from.length === 0) {
		return result;
	}
	return {
		...(result as object),
		content: content.map(part => {
			const text = (part as { type?: unknown; text?: unknown })?.text;
			return (part as { type?: unknown })?.type === 'text' && typeof text === 'string' && text.includes(from)
				? { ...(part as object), text: text.split(from).join(to) }
				: part;
		}),
	};
}

/** ツールの結果の本文に1行足す。 */
function appendText(result: unknown, line: string): unknown {
	const content = (result as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? { ...(result as object), content: [...content, { type: 'text', text: line }] } : result;
}

function toolError(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

/** renderer が返した理由を、エージェントが次に何をすればよいか分かる英文にする。 */
export function paradisRemoteFileFailureMessage(reason: ParadisRemoteFileFailure | undefined, path: string): string {
	switch (reason) {
		case 'invalidPath':
			return `${path} is not usable: give an absolute path on the machine this agent runs on with "/" separators (relative paths are not accepted because Para Code cannot see your working directory), without ".." segments or backslashes.`;
		case 'outsideAllowedFolders':
			return `${path} is outside the folders Para Code may use for this terminal pane on your machine. Write inside the folder of this pane's space or ~/${PARADIS_REMOTE_FILE_USER_FOLDER}; files to read may also be in the system temporary folder (for example /tmp).`;
		case 'versionControlFolder':
			return `${path} is inside a .git, .hg or .svn folder (directly or through a symbolic link), which Para Code never reads or writes for the browser tools. Choose another path.`;
		case 'parentMissing':
			return `The folder of ${path} does not exist on your machine, and Para Code does not create folders there. Choose a path in a folder that already exists (or ~/${PARADIS_REMOTE_FILE_USER_FOLDER}).`;
		case 'notAFile':
			return `${path} exists but is not a regular file.`;
		case 'paneUnresolved':
			return 'PARA_BROWSER_RETRYABLE: Para Code is still restoring this terminal pane, so it cannot tell which folders it may use. Retry in a few seconds.';
		case 'notFound':
			return `${path} does not exist on the machine this agent runs on.`;
		case 'isDirectory':
			return `${path} is a folder, not a file.`;
		case 'tooLarge':
			return `${path} is larger than ${PARADIS_REMOTE_FILE_MAX_BYTES_LABEL}, the most Para Code transfers between your machine and the browser in one call.`;
		case 'noTemporaryFolder':
			return `PARA_BROWSER_RETRYABLE: Para Code could not prepare ~/${PARADIS_REMOTE_FILE_USER_FOLDER} on your machine yet (the remote connection may still be starting). Retry in a few seconds.`;
		case 'ioFailed':
		case undefined:
			return `Para Code could not read or write ${path} on your machine (permissions, or the remote connection was interrupted).`;
	}
}

/** shared process の機能のうち、受け渡しに使うもの。 */
export interface IParadisRemoteFileTransferHost {
	/** 呼び出し元ペインを所有するウィンドウの {@link PARADIS_AGENT_PREVIEW_CHANNEL} を呼ぶ。 */
	callWindow<T>(method: string, args: unknown[]): Promise<ParadisMcpOwningWindowResult<T>>;
	/**
	 * 接続先の受け渡し用フォルダを本人だけが読めるようにする（SSH の接続先で `chmod 700`）。できない接続先
	 * （WSL・コンテナ等）では無い。失敗しても受け渡しは止めない。
	 */
	restrictFolder?(remoteFolder: string): Promise<unknown>;
}

/** renderer が「受け渡し用フォルダの中に書いた」と返したときだけ、そのフォルダを本人だけのものにする（失敗は無視）。 */
async function restrictUserFolder(host: IParadisRemoteFileTransferHost, written: { readonly userFolder?: string }): Promise<void> {
	if (host.restrictFolder !== undefined && written.userFolder !== undefined) {
		await host.restrictFolder(written.userFolder).catch(() => undefined);
	}
}

export class ParadisRemoteFileTransfer {

	private readonly uploadStaging: ParadisFileDropStaging;

	constructor(
		/** 内蔵 chrome-devtools-mcp の一時フォルダ（子プロセスの roots）。作れなければ undefined。 */
		private readonly temporaryDirectory: () => string | undefined,
		private readonly maxBytes: number = PARADIS_REMOTE_FILE_MAX_BYTES,
	) {
		this.uploadStaging = new ParadisFileDropStaging(UPLOAD_STAGING_TTL_MS, UPLOAD_STAGING_MAX_ENTRIES, UPLOAD_STAGING_MAX_TOTAL_BYTES, temporaryDirectory);
	}

	dispose(): void {
		this.uploadStaging.dispose();
	}

	/**
	 * 接続先のパスを手元の一時ファイルに差し替えてツールを動かす。
	 * `callTool` は差し替えた引数でツールを呼ぶ（スクリーンショットの取り出し口の案内は付けないこと）。
	 */
	async callTool(
		toolName: string,
		direction: ParadisRemoteFileDirection,
		args: Record<string, unknown>,
		host: IParadisRemoteFileTransferHost,
		callTool: (args: Record<string, unknown>) => Promise<unknown>,
	): Promise<unknown> {
		const requested = args.filePath;
		const remotePath = paradisNormalizeRemoteFilePath(requested);
		const shown = typeof requested === 'string' ? requested : String(requested);
		if (remotePath === undefined || typeof requested !== 'string') {
			return toolError(`${toolName} was not run: ${paradisRemoteFileFailureMessage('invalidPath', shown)}`);
		}
		return direction === 'output'
			? this.output(toolName, requested, args, host, callTool)
			: this.input(toolName, requested, args, host, callTool);
	}

	private async output(toolName: string, remotePath: string, args: Record<string, unknown>, host: IParadisRemoteFileTransferHost, callTool: (args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
		// 撮ってから断るより先に断る（書けない場所なら重い処理をしない）
		const check = await host.callWindow<ParadisRemoteFileCheckResult>(PARADIS_REMOTE_FILE_CHECK_WRITE_METHOD, [remotePath]);
		if (!check.ok) {
			return toolError(`${toolName} was not run: ${check.error}`);
		}
		if (!check.value.ok) {
			return toolError(`${toolName} was not run: ${paradisRemoteFileFailureMessage(check.value.reason, remotePath)}`);
		}
		const parent = this.temporaryDirectory();
		if (parent === undefined) {
			return toolError(`${toolName} was not run: Para Code could not prepare a temporary folder for the file. Retry, or call ${toolName} without \`filePath\`.`);
		}
		let folder: string;
		try {
			folder = await fs.mkdtemp(join(parent, 'remote-output-'));
		} catch {
			return toolError(`${toolName} was not run: Para Code could not prepare a temporary folder for the file. Retry, or call ${toolName} without \`filePath\`.`);
		}
		try {
			// vendored は拡張子を形式に合わせて付け替える（ensureExtension）。接続先へも同じ名前で書く
			const localPath = join(folder, `output${extname(remotePath.replace(/\\/g, '/'))}`);
			const result = await callTool({ ...args, filePath: localPath });
			const saved = await this.findSavedFile(folder);
			const finalRemotePath = saved === undefined ? remotePath : paradisReplaceRemoteFileExtension(remotePath, extname(saved));
			const rewritten = saved === undefined
				? paradisReplacePathInToolResult(result, localPath, remotePath)
				: paradisReplacePathInToolResult(result, saved, finalRemotePath);
			if ((result as { isError?: unknown } | undefined)?.isError === true || saved === undefined) {
				return rewritten;
			}
			let data: Buffer;
			try {
				const stat = await fs.stat(saved);
				if (stat.size > this.maxBytes) {
					return toolError(`${toolName} ran, but ${paradisRemoteFileFailureMessage('tooLarge', finalRemotePath)} Call it without \`filePath\` to get the result inline.`);
				}
				data = await fs.readFile(saved);
			} catch {
				return toolError(`${toolName} ran, but Para Code could not read the result it saved, so nothing was written to your machine. Retry, or call ${toolName} without \`filePath\`.`);
			}
			const written = await host.callWindow<ParadisRemoteFileWriteResult>(PARADIS_REMOTE_FILE_WRITE_METHOD, [finalRemotePath, VSBuffer.wrap(data)]);
			if (!written.ok) {
				return toolError(`${toolName} ran, but the file could not be written to your machine: ${written.error}`);
			}
			if (!written.value.ok) {
				return toolError(`${toolName} ran, but the file could not be written to your machine: ${paradisRemoteFileFailureMessage(written.value.reason, finalRemotePath)}`);
			}
			await restrictUserFolder(host, written.value);
			return appendText(rewritten, `The file was written to ${finalRemotePath} on the machine this agent runs on (Para Code copied it there from the browser).`);
		} finally {
			await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async input(toolName: string, remotePath: string, args: Record<string, unknown>, host: IParadisRemoteFileTransferHost, callTool: (args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
		const read = await host.callWindow<ParadisRemoteFileReadResult>(PARADIS_REMOTE_FILE_READ_METHOD, [remotePath, this.maxBytes]);
		if (!read.ok) {
			return toolError(`${toolName} was not run: ${read.error}`);
		}
		if (!read.value.ok) {
			return toolError(`${toolName} was not run: ${paradisRemoteFileFailureMessage(read.value.reason, remotePath)}`);
		}
		const bytes = toBuffer(read.value.data);
		if (bytes === undefined) {
			return toolError(`${toolName} was not run: ${paradisRemoteFileFailureMessage('ioFailed', remotePath)}`);
		}
		const name = paradisSanitizeFileDropName(read.value.name) ?? paradisSanitizeFileDropName(basename(remotePath.replace(/\\/g, '/'))) ?? 'upload';
		let localPath: string;
		try {
			localPath = await this.uploadStaging.stage(bytes, name);
		} catch {
			return toolError(`${toolName} was not run: Para Code could not prepare a temporary copy of ${remotePath}. Retry.`);
		}
		const result = await callTool({ ...args, filePath: localPath });
		return paradisReplacePathInToolResult(result, localPath, remotePath);
	}

	/**
	 * 手元に保存したファイル（PDF・ダウンロード）を、接続先のホームの受け渡し用フォルダへ写す。写したパス、または
	 * 写せなかった理由の英文を返す。手元のファイルはそのまま残す（ユーザーのダウンロード一覧に載っている）。
	 */
	async deliverToRemoteTemporaryFolder(localPath: string, host: IParadisRemoteFileTransferHost): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string }> {
		const name = paradisSanitizeFileDropName(basename(localPath)) ?? 'download';
		let stat;
		try {
			stat = await fs.stat(localPath);
		} catch {
			return { ok: false, message: 'the saved file could not be read on the machine running Para Code' };
		}
		if (!stat.isFile()) {
			return { ok: false, message: 'the saved path is not a file' };
		}
		if (stat.size > this.maxBytes) {
			return { ok: false, message: `it is larger than ${PARADIS_REMOTE_FILE_MAX_BYTES_LABEL}, the most Para Code copies to your machine in one call` };
		}
		let data: Buffer;
		try {
			data = await fs.readFile(localPath);
		} catch {
			return { ok: false, message: 'the saved file could not be read on the machine running Para Code' };
		}
		const written = await host.callWindow<ParadisRemoteFileWriteResult>(PARADIS_REMOTE_FILE_WRITE_TEMPORARY_METHOD, [name, VSBuffer.wrap(data)]);
		if (!written.ok) {
			return { ok: false, message: written.error };
		}
		if (!written.value.ok) {
			return { ok: false, message: paradisRemoteFileFailureMessage(written.value.reason, name) };
		}
		await restrictUserFolder(host, written.value);
		return { ok: true, path: written.value.path };
	}

	/** 一時フォルダに出来たファイル（vendored が拡張子を付け替えた名前）を探す。 */
	private async findSavedFile(folder: string): Promise<string | undefined> {
		const names = await fs.readdir(folder).catch(() => [] as string[]);
		const name = names.find(candidate => candidate.startsWith('output'));
		return name === undefined ? undefined : join(folder, name);
	}
}

/** IPC で届いた中身（VSBuffer）を Buffer にする。 */
function toBuffer(data: unknown): Buffer | undefined {
	if (data instanceof VSBuffer) {
		return Buffer.from(data.buffer.buffer, data.buffer.byteOffset, data.buffer.byteLength);
	}
	if (data instanceof Uint8Array) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	}
	return undefined;
}
