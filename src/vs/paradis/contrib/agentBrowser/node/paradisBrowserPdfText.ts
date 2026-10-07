/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// read_download の PDF。PDF ビューア用に同梱している pdf.js（media/pdfjs/）で、ページごとのテキストを取り出す。
// pdf.js は shared process では動かさず、使うたびに worker_threads の Worker を 1 つ立てて、その中で読む。
// - pdf.js の本体は読み込んだ時点で DOMMatrix を使う。shared process には無いので、Worker の中にだけ空の DOMMatrix を置く
//   （テキストを取るだけなら描画は使わないので中身は要らない。shared process の global は汚さない）
// - 重い PDF でも shared process の処理を止めない。時間の上限を過ぎたら Worker ごと止める
// - Worker の入口は文字列（eval）にして、ビルドに入口を足さずに済ませる。pdf.js は配布物の media/pdfjs/ を import する

import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { FileAccess } from '../../../../base/common/network.js';

/** 1 回に読むページ数の上限。 */
export const PARADIS_PDF_MAX_PAGES = 50;
/** 1 回に返す文字数の上限（ページをまたいだ合計）。 */
export const PARADIS_PDF_MAX_CHARS = 100_000;
/** 1 回の処理時間の上限。過ぎたら読めたページまでを返す。 */
export const PARADIS_PDF_SOFT_TIMEOUT_MS = 15_000;
/** これを過ぎても Worker が返さなければ止める（1 ページで固まった場合）。 */
export const PARADIS_PDF_HARD_TIMEOUT_MS = 20_000;
/** Worker の JavaScript のメモリの上限（MB）。入力の 50MiB に対して余裕を見た値。 */
const WORKER_MAX_OLD_GENERATION_MB = 512;

const PDFJS_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/pdfjs';

/** 読むページの範囲（1 始まり）。`end` が無ければ最後のページまで。 */
export interface IParadisPdfPageRange {
	readonly start: number;
	readonly end?: number;
}

export interface IParadisPdfTextOptions {
	readonly range?: IParadisPdfPageRange;
	readonly maxPages?: number;
	readonly maxChars?: number;
	readonly softTimeoutMs?: number;
	readonly hardTimeoutMs?: number;
}

export interface IParadisPdfPageText {
	readonly page: number;
	readonly text: string;
}

export type ParadisPdfTextResult =
	| {
		readonly kind: 'ok';
		readonly numPages: number;
		readonly pages: readonly IParadisPdfPageText[];
		/** 範囲の途中で止めた理由。最後まで読めたら undefined。 */
		readonly stopped?: 'pages' | 'chars' | 'time';
	}
	| { readonly kind: 'outOfRange'; readonly numPages: number }
	| { readonly kind: 'password' }
	| { readonly kind: 'invalid' }
	| { readonly kind: 'timeout' }
	| { readonly kind: 'failed'; readonly message: string };

/** "3"、"1-5"、"10-"（10 ページ目から最後まで）を読む。読めなければ undefined。 */
export function paradisParsePdfPageRange(value: string): IParadisPdfPageRange | undefined {
	const match = /^\s*(?<start>\d{1,6})\s*(?:(?<dash>-)\s*(?<end>\d{1,6})?)?\s*$/.exec(value);
	if (!match?.groups) {
		return undefined;
	}
	const start = Number(match.groups.start);
	const end = match.groups.end !== undefined ? Number(match.groups.end) : match.groups.dash ? undefined : start;
	if (start < 1 || (end !== undefined && end < start)) {
		return undefined;
	}
	return end === undefined ? { start } : { start, end };
}

/**
 * Worker の中で動く処理（CommonJS の文字列）。workerData: { lib, worker, data, start, end, maxPages, maxChars, softTimeoutMs }。
 * 結果は ParadisPdfTextResult の形で 1 回だけ返す。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
(async () => {
	const started = Date.now();
	let task;
	try {
		globalThis.DOMMatrix ??= class DOMMatrix {};
		// Electron の V8 にはあるが、Node 24（単体テストの実行環境）には無い
		if (!Uint8Array.prototype.toHex) {
			Object.defineProperty(Uint8Array.prototype, 'toHex', { value: function () { return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join(''); }, writable: true, configurable: true });
		}
		const lib = await import(workerData.lib);
		globalThis.pdfjsWorker = await import(workerData.worker);
		lib.GlobalWorkerOptions.workerSrc = workerData.worker;
		task = lib.getDocument({ data: workerData.data, verbosity: 0, disableFontFace: true, isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false, stopAtErrors: false });
		const doc = await task.promise;
		const numPages = doc.numPages;
		if (workerData.start > numPages) {
			parentPort.postMessage({ kind: 'outOfRange', numPages });
			return;
		}
		const last = Math.min(numPages, workerData.end ?? numPages);
		const pages = [];
		let chars = 0;
		let stopped;
		for (let number = workerData.start; number <= last; number++) {
			if (pages.length >= workerData.maxPages) { stopped = 'pages'; break; }
			if (Date.now() - started > workerData.softTimeoutMs) { stopped = 'time'; break; }
			const page = await doc.getPage(number);
			const content = await page.getTextContent();
			page.cleanup();
			let text = '';
			for (const item of content.items) {
				if (typeof item.str === 'string') {
					text += item.str + (item.hasEOL ? '\\n' : '');
				}
			}
			text = text.split('\\n').map(line => line.trimEnd()).join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
			if (chars + text.length > workerData.maxChars) {
				pages.push({ page: number, text: text.slice(0, Math.max(0, workerData.maxChars - chars)) });
				stopped = 'chars';
				break;
			}
			chars += text.length;
			pages.push({ page: number, text });
		}
		parentPort.postMessage({ kind: 'ok', numPages, pages, stopped });
	} catch (error) {
		const name = error && error.name;
		parentPort.postMessage(name === 'PasswordException' ? { kind: 'password' }
			: name === 'InvalidPDFException' || name === 'FormatError' ? { kind: 'invalid' }
				: { kind: 'failed', message: String(error && error.message || error).slice(0, 300) });
	} finally {
		if (task) {
			await task.destroy().catch(() => undefined);
		}
	}
})();
`;

function pdfjsFileUrl(file: string): string {
	return pathToFileURL(FileAccess.asFileUri(`${PDFJS_ROOT}/${file}`).fsPath).href;
}

/**
 * PDF のバイト列から、ページごとのテキストを取り出す。Worker を立てて読み、終わったら必ず止める。
 * 失敗は例外にせず、結果の `kind` で返す。
 */
export async function paradisExtractPdfText(data: Uint8Array, options: IParadisPdfTextOptions = {}): Promise<ParadisPdfTextResult> {
	const range = options.range ?? { start: 1 };
	// Worker に渡す（transfer する）ので、呼び出し元の Buffer とは別の領域に写す
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	let worker: Worker;
	try {
		worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: {
				lib: pdfjsFileUrl('pdf.min.mjs'),
				worker: pdfjsFileUrl('pdf.worker.min.mjs'),
				data: copy,
				start: range.start,
				end: range.end,
				maxPages: options.maxPages ?? PARADIS_PDF_MAX_PAGES,
				maxChars: options.maxChars ?? PARADIS_PDF_MAX_CHARS,
				softTimeoutMs: options.softTimeoutMs ?? PARADIS_PDF_SOFT_TIMEOUT_MS,
			},
			transferList: [copy.buffer],
			resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB },
			stdout: true,
			stderr: true,
		});
	} catch (error) {
		return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	try {
		return await new Promise<ParadisPdfTextResult>(resolve => {
			const timer = setTimeout(() => resolve({ kind: 'timeout' }), options.hardTimeoutMs ?? PARADIS_PDF_HARD_TIMEOUT_MS);
			const settle = (result: ParadisPdfTextResult) => {
				clearTimeout(timer);
				resolve(result);
			};
			worker.once('message', message => settle(message as ParadisPdfTextResult));
			worker.once('error', error => settle({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }));
			worker.once('exit', code => settle({ kind: 'failed', message: `the PDF reader stopped (exit code ${code})` }));
		});
	} finally {
		await worker.terminate().catch(() => undefined);
	}
}
