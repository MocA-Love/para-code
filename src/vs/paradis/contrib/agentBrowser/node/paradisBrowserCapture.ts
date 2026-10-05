/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の capture_screenshot（矩形・要素の切り抜き、複数の要素、エージェント側への保存）。
// 要素の位置は「読む・待つ」ツールと同じページの関数で求め、撮影は take_screenshot が CDP 経由で使うのと
// 同じ electron-main の撮影（captureExactViewScreenshot）を直接呼ぶ。保存はサービスに任せる
// （手元のペインは roots の中だけ、接続先のペインは接続先のパスへ書き戻す既存の経路）。

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, relative, sep } from '../../../../base/common/path.js';
import { IParadisCdpScreenshotOptions } from '../common/paradisAgentBrowser.js';
import { paradisPathHasVersionControlSegment } from '../common/paradisRemoteFileBridge.js';
import { IParadisQuerySpec, paradisBuildQueryFunction, paradisIsLocatorError, paradisIsTransientEvaluateFailure, paradisParseEvaluateValue, paradisParseQueryLocator } from './paradisBrowserQuery.js';

/** 1 回で撮れる要素の数。 */
export const PARADIS_CAPTURE_MAX_ELEMENTS = 10;

/** ツールの実行中にサービスから借りるもの。 */
export interface IParadisBrowserCaptureCall {
	evaluate(functionSource: string, uids: readonly string[]): Promise<unknown>;
	isCurrent(): boolean;
	/** 撮って base64 を返す。失敗は投げる（文は PARA_BROWSER_RETRYABLE などエージェントへ返せる形）。 */
	capture(options: IParadisCdpScreenshotOptions): Promise<string>;
	/** エージェントの機械の `path` に書く。書いたパス（拡張子が変わることがある）か、書けなかった理由。 */
	save(path: string, data: Buffer): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string }>;
}

type ToolResult = unknown;

function error(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

const BINDING_CHANGED = 'PARA_BROWSER_RETRYABLE: the page shared with this terminal pane changed while the tool was running; check get_shared_page and retry.';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

interface IShot {
	readonly label: string;
	readonly options: IParadisCdpScreenshotOptions;
	readonly element?: unknown;
}

/** `saveTo` から、n 枚目の保存先を作る（1 枚なら拡張子だけ合わせる）。 */
export function paradisCaptureSavePath(saveTo: string, index: number, count: number, extension: string): string {
	const slash = Math.max(saveTo.lastIndexOf('/'), saveTo.lastIndexOf('\\'));
	const dot = saveTo.lastIndexOf('.');
	const hasExtension = dot > slash + 1;
	const base = hasExtension ? saveTo.slice(0, dot) : saveTo;
	const given = hasExtension ? saveTo.slice(dot).toLowerCase() : '';
	const ext = given === extension || (extension === '.jpeg' && given === '.jpg') ? saveTo.slice(dot) : extension;
	return `${base}${count > 1 ? `-${index + 1}` : ''}${ext}`;
}

/**
 * 手元のペインの保存先を確かめる。許す場所は `roots`（スペースのフォルダ・一時フォルダ）の中だけで、
 * `.git` などの中は断る。まだ無いフォルダは、実在する一番近い祖先の realpath で見る（シンボリックリンクで
 * 外へ出ないように）。断るときはその文を返す。
 */
export async function paradisCaptureLocalPathRefusal(path: string, roots: readonly string[], realpath: (path: string) => Promise<string> = p => fs.realpath(p)): Promise<string | undefined> {
	if (!isAbsolute(path)) {
		return `"saveTo" must be an absolute path (got ${JSON.stringify(path)}).`;
	}
	if (paradisPathHasVersionControlSegment(path)) {
		return '"saveTo" points inside a .git, .hg or .svn folder, which the browser tools never write. Choose another path.';
	}
	let probe = dirname(path);
	const rest: string[] = [];
	let real: string | undefined;
	for (; ;) {
		real = await realpath(probe).catch(() => undefined);
		if (real !== undefined) {
			break;
		}
		const parent = dirname(probe);
		if (parent === probe) {
			break;
		}
		rest.unshift(probe.slice(parent.length).replace(/^[\\/]/, ''));
		probe = parent;
	}
	if (real === undefined) {
		return `Para Code could not resolve the folder of "saveTo" (${path}).`;
	}
	const target = join(real, ...rest);
	if (paradisPathHasVersionControlSegment(target)) {
		return '"saveTo" points inside a .git, .hg or .svn folder (through a symbolic link), which the browser tools never write. Choose another path.';
	}
	const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => root)));
	const inside = realRoots.some(root => {
		const between = relative(root, target);
		return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between));
	});
	if (!inside) {
		return `"saveTo" (${path}) is outside the folders the browser tools may write to. Use a path inside one of: ${roots.join(', ')}.`;
	}
	return undefined;
}

export class ParadisBrowserCapture {

	async call(call: IParadisBrowserCaptureCall, rawArgs: unknown): Promise<ToolResult> {
		const args = isRecord(rawArgs) ? rawArgs : {};
		const format = args.format ?? 'png';
		if (format !== 'png' && format !== 'jpeg') {
			return error('"format" must be "png" or "jpeg".');
		}
		const quality = args.quality;
		if (quality !== undefined && (format !== 'jpeg' || typeof quality !== 'number' || !Number.isInteger(quality) || quality < 0 || quality > 100)) {
			return error('"quality" is for "format": "jpeg" only, an integer from 0 to 100.');
		}
		const padding = args.padding ?? 0;
		if (!isFiniteNumber(padding) || padding < 0 || padding > 200) {
			return error('"padding" must be a number from 0 to 200 (CSS pixels).');
		}
		const saveTo = args.saveTo;
		if (saveTo !== undefined && (typeof saveTo !== 'string' || saveTo.length === 0 || saveTo.length > 4096)) {
			return error('"saveTo" must be a file path.');
		}
		const base: IParadisCdpScreenshotOptions = { format, ...(typeof quality === 'number' ? { quality } : {}) };

		const shots: IShot[] = [];
		const locatorKeys = ['uid', 'selector', 'role', 'name', 'text', 'within', 'within_uid', 'exact', 'index'];
		const topLevelLocator = locatorKeys.some(key => args[key] !== undefined);
		const given = [args.rect !== undefined, args.elements !== undefined, topLevelLocator].filter(Boolean).length;
		if (given !== 1) {
			return error('Give exactly one of: "rect" (a rectangle of the viewport), "elements" (a list of elements), or one element (uid, selector, role + name or text). For the whole page use take_screenshot.');
		}
		if (args.rect !== undefined) {
			const rect = args.rect;
			if (!isRecord(rect) || !isFiniteNumber(rect.x) || !isFiniteNumber(rect.y) || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) {
				return error('"rect" must be {"x", "y", "width", "height"} in CSS pixels of the viewport (as in a take_screenshot of the viewport), with width and height of at least 1.');
			}
			shots.push({ label: `rect (${rect.x}, ${rect.y}, ${rect.width}x${rect.height})`, options: { ...base, pageRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } });
		} else {
			const locators = args.elements !== undefined ? args.elements : [Object.fromEntries(locatorKeys.filter(key => args[key] !== undefined).map(key => [key, args[key]]))];
			if (!Array.isArray(locators) || locators.length === 0 || locators.length > PARADIS_CAPTURE_MAX_ELEMENTS || !locators.every(isRecord)) {
				return error(`"elements" must be a list of 1 to ${PARADIS_CAPTURE_MAX_ELEMENTS} elements, each like {"uid": "..."} or {"role": "button", "name": "Save"}.`);
			}
			for (const [position, entry] of locators.entries()) {
				const shot = await this.elementShot(call, entry as Record<string, unknown>, position, locators.length, base, padding);
				if (!shot.ok) {
					return shot.result;
				}
				shots.push(shot.shot);
			}
		}

		const content: unknown[] = [];
		const lines: string[] = [];
		const extension = format === 'png' ? '.png' : '.jpeg';
		for (const [index, shot] of shots.entries()) {
			let data: string;
			try {
				data = await call.capture(shot.options);
			} catch (cause) {
				// 共有やペインが無くなった（ingress lease の失効）は isCurrent が投げて、呼び出し全体の失敗になる
				if (!call.isCurrent()) {
					return error(BINDING_CHANGED);
				}
				const message = cause instanceof Error ? cause.message : String(cause);
				return error(`capture_screenshot could not capture ${shot.label}: ${message}`);
			}
			if (!call.isCurrent()) {
				return error(BINDING_CHANGED);
			}
			const element = shot.element !== undefined ? ` ${JSON.stringify(shot.element)}` : '';
			if (typeof saveTo === 'string') {
				const saved = await call.save(paradisCaptureSavePath(saveTo, index, shots.length, extension), Buffer.from(data, 'base64'));
				if (!saved.ok) {
					return error(`capture_screenshot captured ${shot.label} but could not save it: ${saved.message}${index > 0 ? ` (${index} earlier image(s) were saved)` : ''}`);
				}
				lines.push(`${index + 1}. ${shot.label} saved to ${saved.path}.${element}`);
			} else {
				lines.push(`${index + 1}. ${shot.label}.${element}`);
				content.push({ type: 'image', data, mimeType: format === 'png' ? 'image/png' : 'image/jpeg' });
			}
		}
		return { content: [{ type: 'text', text: `Captured ${shots.length} image(s).\n${lines.join('\n')}` }, ...content] };
	}

	private async elementShot(call: IParadisBrowserCaptureCall, entry: Record<string, unknown>, position: number, count: number, base: IParadisCdpScreenshotOptions, padding: number): Promise<{ ok: true; shot: IShot } | { ok: false; result: ToolResult }> {
		const prefix = count > 1 ? `Element ${position + 1}: ` : '';
		const locator = paradisParseQueryLocator(entry);
		if (paradisIsLocatorError(locator)) {
			return { ok: false, result: error(`${prefix}${locator.error}`) };
		}
		if (!locator.given) {
			return { ok: false, result: error(`${prefix}give uid, selector, role + name or text.`) };
		}
		const index = entry.index;
		if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 0)) {
			return { ok: false, result: error(`${prefix}"index" must be a non-negative integer.`) };
		}
		const spec: IParadisQuerySpec = { ...locator.spec, mode: 'rect', ...(typeof index === 'number' ? { index } : {}) };
		const result = await call.evaluate(paradisBuildQueryFunction(spec, locator.uids.length), locator.uids);
		if (!call.isCurrent()) {
			return { ok: false, result: error(BINDING_CHANGED) };
		}
		if ((result as { isError?: unknown } | undefined)?.isError === true) {
			return { ok: false, result: paradisIsTransientEvaluateFailure(result) ? error('PARA_BROWSER_RETRYABLE: the page was navigating while the element was looked up. Retry once.') : result };
		}
		const value = paradisParseEvaluateValue(result)?.value;
		if (!isRecord(value)) {
			return { ok: false, result: error('PARA_BROWSER_RETRYABLE: the page did not return a readable result (it may have been navigating). Retry once.') };
		}
		if (value.withinMissing === true || value.matched === 0) {
			return { ok: false, result: error(`${prefix}no element matches. Check with take_snapshot, or wait for it with wait_until.`) };
		}
		if (value.noIndex === true) {
			return { ok: false, result: error(`${prefix}only ${value.matched} element(s) match, so there is no index ${index}.`) };
		}
		if (value.problem === 'iframe') {
			return { ok: false, result: error(`${prefix}the element is inside an iframe; capture a "rect" of the viewport around it instead.`) };
		}
		const { x, y, width, height, documentWidth, documentHeight } = value as Record<string, number>;
		if (!(width > 0 && height > 0)) {
			return { ok: false, result: error(`${prefix}the element has zero size (hidden or not rendered). Element: ${JSON.stringify(value.element)}`) };
		}
		const left = Math.max(0, x - padding);
		const top = Math.max(0, y - padding);
		const right = Math.min(isFiniteNumber(documentWidth) ? documentWidth : x + width + padding, x + width + padding);
		const bottom = Math.min(isFiniteNumber(documentHeight) ? documentHeight : y + height + padding, y + height + padding);
		const shot: IShot = {
			label: `${count > 1 ? `element ${position + 1}` : 'element'} (${Math.round(width)}x${Math.round(height)})`,
			element: value.element,
			// 文書の座標で撮る（画面の外の要素もスクロールせずに撮れる）
			options: { ...base, pageRect: { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }, captureBeyondViewport: true },
		};
		return { ok: true, shot };
	}
}
