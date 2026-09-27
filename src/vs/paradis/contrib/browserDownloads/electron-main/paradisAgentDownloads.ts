/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが触っているタブからのダウンロードと、エージェントが書き出すファイル（PDF）の決め事。
//
// - エージェントに共有しているタブ（利用者のタブでも）から始まったダウンロードは、エージェント由来として
//   一覧に載せる（「開く」を出さず「フォルダで表示」だけ）。共有中かどうかは CDP の通り道
//   （paradisCdpTargetService.ts）が、エージェントがタブを手にした・手放した合図で知らせてくる。
// - para-browser MCP の download_by_click は、クリックの前に「このタブのダウンロードを待つ」と登録し、
//   `will-download` で始まったダウンロードの一覧の id を受け取る。
// - save_page_as_pdf の PDF はダウンロードと同じフォルダへ、上書きせずに置く。

import * as fs from 'fs';
import { generateUuid } from '../../../../base/common/uuid.js';
import { join } from '../../../../base/common/path.js';
import { ParadisBrowserDownloadsTracker } from './paradisBrowserDownloadsTracker.js';

/**
 * main に1つだけあるダウンロードの一覧（paradisBrowserDownloads.ts が作ったときに知らせる）。
 * ここに置くのは、CDP の通り道（paradisCdpTargetService.ts）が Electron の app / shell を読み込む
 * モジュールへ依存せずに一覧を使えるようにするため。
 */
let agentDownloadsTracker: ParadisBrowserDownloadsTracker | undefined;

export function paradisSetAgentDownloadsTracker(tracker: ParadisBrowserDownloadsTracker): void {
	agentDownloadsTracker = tracker;
}

/** 一覧（起動時に app.ts の登録で作られる）。まだ無ければ undefined。 */
export function paradisGetAgentDownloadsTracker(): ParadisBrowserDownloadsTracker | undefined {
	return agentDownloadsTracker;
}

/** エージェントが手にしているタブの webContents。 */
const heldByAgent = new WeakSet<object>();

/** エージェントがタブを手にした（true）・手放した（false）。 */
export function paradisSetWebContentsHeldByAgent(webContents: object, held: boolean): void {
	if (held) {
		heldByAgent.add(webContents);
	} else {
		heldByAgent.delete(webContents);
	}
}

interface IAgentDownloadExpectation {
	readonly webContents: object;
	entryId: string | undefined;
	readonly waiters: ((entryId: string | undefined) => void)[];
	timer: ReturnType<typeof setTimeout> | undefined;
}

const expectations = new Map<string, IAgentDownloadExpectation>();
/** 同時に待てる数（1 ペイン 1 件 × 余裕）。溢れたら古いものから諦める。 */
const MAX_EXPECTATIONS = 64;

function settleExpectation(id: string, entryId: string | undefined): void {
	const expectation = expectations.get(id);
	if (!expectation) {
		return;
	}
	if (expectation.timer !== undefined) {
		clearTimeout(expectation.timer);
		expectation.timer = undefined;
	}
	expectation.entryId ??= entryId;
	for (const waiter of expectation.waiters.splice(0)) {
		waiter(expectation.entryId);
	}
	expectations.delete(id);
}

/**
 * このタブで次に始まるダウンロードを待つと登録する。`startTimeoutMs` の間に始まらなければ諦める。
 * 返した id で {@link paradisAwaitAgentDownloadStart} を呼ぶ。
 */
export function paradisExpectAgentDownload(webContents: object, startTimeoutMs: number): string {
	while (expectations.size >= MAX_EXPECTATIONS) {
		const oldest = expectations.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		settleExpectation(oldest, undefined);
	}
	const id = generateUuid();
	const expectation: IAgentDownloadExpectation = { webContents, entryId: undefined, waiters: [], timer: undefined };
	expectation.timer = setTimeout(() => settleExpectation(id, undefined), startTimeoutMs);
	expectations.set(id, expectation);
	return id;
}

/** 始まったダウンロードの一覧の id。始まらずに諦めたら undefined。 */
export function paradisAwaitAgentDownloadStart(id: string): Promise<string | undefined> {
	const expectation = expectations.get(id);
	if (!expectation) {
		return Promise.resolve(undefined);
	}
	if (expectation.entryId !== undefined) {
		const entryId = expectation.entryId;
		settleExpectation(id, entryId);
		return Promise.resolve(entryId);
	}
	return new Promise(resolve => expectation.waiters.push(resolve));
}

/** クリックに失敗したときなど、待つのをやめる。 */
export function paradisCancelAgentDownloadExpectation(id: string): void {
	settleExpectation(id, undefined);
}

/**
 * `will-download` の時点で、そのダウンロードをエージェント由来として扱うか。
 * エージェントが手にしているタブか、エージェントのクリックを待っているタブなら true。
 */
export function paradisIsAgentDownload(webContents: object | undefined): boolean {
	if (webContents === undefined) {
		return false;
	}
	if (heldByAgent.has(webContents)) {
		return true;
	}
	for (const expectation of expectations.values()) {
		if (expectation.webContents === webContents) {
			return true;
		}
	}
	return false;
}

/** 始まったダウンロードを、そのタブで待っている登録へ知らせる。 */
export function paradisNotifyAgentDownloadStarted(webContents: object | undefined, entryId: string | undefined): void {
	if (webContents === undefined || entryId === undefined) {
		return;
	}
	for (const [id, expectation] of [...expectations]) {
		if (expectation.webContents === webContents && expectation.entryId === undefined) {
			settleExpectation(id, entryId);
		}
	}
}

/** 同じ名前のファイルがあれば ` (1)` を足して、上書きせずに書く。書いたパスを返す。 */
export async function paradisWriteFileWithoutOverwrite(directory: string, fileName: string, data: Uint8Array): Promise<string> {
	await fs.promises.mkdir(directory, { recursive: true });
	const dot = fileName.lastIndexOf('.');
	const base = dot > 0 ? fileName.slice(0, dot) : fileName;
	const ext = dot > 0 ? fileName.slice(dot) : '';
	for (let i = 0; i < 1000; i++) {
		const candidate = join(directory, i === 0 ? fileName : `${base} (${i})${ext}`);
		try {
			// 'wx' は既にあると失敗するので、確かめてから書くまでの間に別のファイルができても上書きしない。
			await fs.promises.writeFile(candidate, data, { flag: 'wx' });
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
				throw error;
			}
		}
	}
	throw new Error('Too many files with the same name in the download folder.');
}

/** エージェントが書き出したファイルを、ダウンロードと同じフォルダへ置いて一覧に載せる。 */
export async function paradisSaveAgentFile(tracker: ParadisBrowserDownloadsTracker, fileName: string, data: Uint8Array, sourceUrl: string): Promise<string> {
	const path = await paradisWriteFileWithoutOverwrite(tracker.downloadsDirectory(), fileName, data);
	tracker.trackSavedFile(path, sourceUrl, data.byteLength);
	return path;
}
