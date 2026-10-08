/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 入力・遷移の道具の結果の末尾に、操作の後のページの様子を添える（para-browser-improvement.html の E1 と I1）。
//   - E1（`paradis.agentBrowser.settleAfterAction`）: 操作の後、DOM の変化が止まり通信が落ち着くまで
//     （既定で上限 2 秒、`settle_ms`）道具の側で待ち、URL・タイトルの変化と、増えた・変わった・消えた要素を返す
//   - I1（`paradis.agentBrowser.reportBrowserState`）: 使えるタブ、その操作で開いたページ、新しいダウンロード、
//     開いているダイアログを返す。前回の報告と同じなら省く
// どちらも既定は無効。待ちと変化の取り方はページの中の関数（paradisBrowserObservePageScript.ts）で行う。
//
// 決め事:
// - 操作が失敗したときは何も添えない（記録は 60 秒でページの中で止まる）
// - JavaScript のダイアログが開いているときは evaluate_script を呼ばない（呼ぶと止まる）。ダイアログだけを伝える
// - run_steps の中の手順ごとには添えず、run_steps 全体の後に 1 回だけ添える
// - 足した引数（`settle_ms`・`observe`）は、道具へ渡す前に必ず取り除く（内蔵 chrome-devtools-mcp は未知の引数を断る）

import { generateUuid } from '../../../../base/common/uuid.js';
import { paradisIsTransientEvaluateFailure, paradisParseEvaluateValue } from './paradisBrowserQuery.js';
import { paradisObserveCollectFunction, paradisObserveInstallFunction, paradisObserveReadFunction } from './paradisBrowserObservePageScript.js';

/** 変化を添える道具（E1）。 */
const SETTLE_TOOLS: ReadonlySet<string> = new Set([
	'click_by', 'fill_by', 'click', 'click_at', 'mouse_action', 'fill', 'fill_form', 'type_text', 'press_key', 'navigate_page', 'handle_dialog', 'run_steps',
]);
/** 状態を添える道具（I1）。 */
const STATE_TOOLS: ReadonlySet<string> = new Set([...SETTLE_TOOLS, 'download_by_click', 'drag', 'hover']);

/** DOM の変化がこれだけ止まったら落ち着いたとみなす。 */
const QUIET_MS = 150;
/** 待ちの上限の既定と最大。 */
export const PARADIS_SETTLE_DEFAULT_MS = 2000;
const SETTLE_MAX_MS = 10_000;
/** 記録を読む間隔。 */
const POLL_MS = 100;
/** 返す行の上限。 */
const MAX_LINES = 30;

export interface IParadisObserveOptions {
	readonly settle: boolean;
	readonly state: boolean;
}

/** この道具の呼び出しで、何を添えるか。添えないなら undefined。 */
export function paradisObserveOptionsFor(name: string, settings: IParadisObserveOptions): IParadisObserveOptions | undefined {
	const settle = settings.settle && SETTLE_TOOLS.has(name);
	const state = settings.state && STATE_TOOLS.has(name);
	return settle || state ? { settle, state } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 足した引数を取り除く。`observe: 'none'` か `settle_ms: 0` なら待ちも変化も省く。 */
export function paradisTakeObserveArguments(args: unknown): { readonly rest: unknown; readonly settleMs: number; readonly observe: 'changes' | 'none' | 'snapshot' } {
	if (!isRecord(args) || (!Object.hasOwn(args, 'settle_ms') && !Object.hasOwn(args, 'observe'))) {
		return { rest: args, settleMs: PARADIS_SETTLE_DEFAULT_MS, observe: 'changes' };
	}
	const { settle_ms: settleValue, observe: observeValue, ...rest } = args;
	const settleMs = typeof settleValue === 'number' && Number.isFinite(settleValue) ? Math.max(0, Math.min(SETTLE_MAX_MS, Math.round(settleValue))) : PARADIS_SETTLE_DEFAULT_MS;
	const observe = observeValue === 'none' || observeValue === 'snapshot' ? observeValue : 'changes';
	return { rest, settleMs, observe };
}

/** tools/list の道具に、E1 の引数と説明を足す（E1 が有効で、対象の道具のときだけ）。 */
export function paradisWithObserveArguments<T extends { readonly name: string; readonly description?: string; readonly inputSchema?: unknown }>(tool: T, settings: IParadisObserveOptions): T {
	const options = paradisObserveOptionsFor(tool.name, settings);
	if (!options || !isRecord(tool.inputSchema)) {
		return tool;
	}
	const properties: Record<string, unknown> = isRecord(tool.inputSchema.properties) ? { ...tool.inputSchema.properties } : {};
	const notes: string[] = [];
	if (options.settle) {
		properties.settle_ms = { type: 'number', description: `After the action, wait up to this many milliseconds for the page to settle (no DOM change for ${QUIET_MS} ms and no request in flight) before reporting what changed. Default ${PARADIS_SETTLE_DEFAULT_MS}, 0 to not wait.` };
		properties.observe = { type: 'string', enum: ['changes', 'none', 'snapshot'], description: 'What to append after the action: "changes" (default: URL/title change and the elements that appeared, changed or disappeared), "snapshot" (the full page snapshot) or "none".' };
		notes.push(`After the action Para Code waits for the page to settle (up to ${PARADIS_SETTLE_DEFAULT_MS} ms) and appends what changed on the page, so you usually do not need take_snapshot or wait_until right after it.`);
	}
	if (options.state) {
		notes.push('When the browser state changed, the result also lists your tabs, pages this action opened, new downloads and an open dialog.');
	}
	return { ...tool, description: `${tool.description ?? ''} ${notes.join(' ')}`.trim(), inputSchema: { ...tool.inputSchema, properties } };
}

/** 観測に要る、サービスから借りるもの。 */
export interface IParadisObserveHost {
	/** 対象のタブで evaluate_script を呼ぶ（MCP の結果を返す）。 */
	evaluate(functionSource: string): Promise<unknown>;
	/** 対象のタブで内蔵 chrome-devtools-mcp の list_pages を呼ぶ（MCP の結果を返す）。ダイアログの有無もここで分かる。 */
	listPages(): Promise<unknown>;
	/** take_snapshot を呼ぶ（observe: snapshot）。 */
	snapshot(): Promise<unknown>;
	/** ペインの通信の様子（終わっていない要求の数と、最後の出入りからの経過）。 */
	network(): { readonly inflight: number; readonly quietMs: number | undefined } | undefined;
	/** エージェントが使えるタブ（I1）。取れなければ undefined。 */
	tabs(): Promise<readonly { readonly tabId: string; readonly url: string; readonly title: string; readonly current: boolean; readonly shared: boolean }[] | undefined>;
	/** ダウンロードの保存先の中のファイル（名前 → 大きさ）。取れなければ undefined。 */
	downloads(): Promise<ReadonlyMap<string, number> | undefined>;
	isCurrent(): boolean;
	sleep(ms: number): Promise<void>;
	now(): number;
}

interface IPageEntry {
	readonly index: string;
	readonly title: string;
	readonly url: string;
	readonly selected: boolean;
}

interface IPagesState {
	readonly pages: readonly IPageEntry[];
	readonly dialog?: string;
}

/** list_pages の本文から、ページの一覧と開いているダイアログを読む。 */
export function paradisParseListPages(result: unknown): IPagesState | undefined {
	if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
		return undefined;
	}
	const text = result.content.filter(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string').map(item => (item as { text: string }).text).join('\n');
	const pages: IPageEntry[] = [];
	for (const line of text.split('\n')) {
		const match = /^(?<index>\d+): (?<title>.*) \((?<url>[^()\s]*)\)(?<selected> \[selected\])?\s*$/.exec(line);
		if (match?.groups) {
			pages.push({ index: match.groups.index, title: match.groups.title, url: match.groups.url, selected: match.groups.selected !== undefined });
		}
	}
	const dialog = /# Open dialog\n(?<dialog>[^\n]*)/.exec(text)?.groups?.dialog;
	return { pages, ...(dialog ? { dialog: dialog.replace(/\.$/, '') } : {}) };
}

interface IBefore {
	readonly name: string;
	readonly installed: boolean;
	readonly url?: string;
	readonly title?: string;
	readonly pages?: IPagesState;
	readonly downloads?: ReadonlyMap<string, number>;
}

interface ICollected {
	readonly missing?: boolean;
	readonly url?: string;
	readonly title?: string;
	readonly navigated?: boolean;
	readonly added?: readonly string[];
	readonly changed?: readonly string[];
	readonly removed?: readonly string[];
	readonly focus?: string;
	readonly text?: string;
	readonly more?: number;
}

/** 待たない評価が、ダイアログが開いているために断られたか。 */
function paradisIsDialogOpenFailure(result: unknown): boolean {
	const content = isRecord(result) && result.isError === true && Array.isArray(result.content) ? result.content : [];
	return content.some(item => isRecord(item) && typeof item.text === 'string' && item.text.includes('PARA_BROWSER_DIALOG_OPEN'));
}

function evaluated<T>(result: unknown): T | undefined {
	const parsed = paradisParseEvaluateValue(result);
	return parsed && isRecord(parsed.value) ? parsed.value as T : undefined;
}

/**
 * 操作の前後を見て、結果に添える文を作る。ペインごとに前回報告した状態を覚え、同じなら省く。
 */
export class ParadisBrowserObserver {
	/** ペイン（とタブ）ごとに、前回報告した状態の鍵。 */
	private readonly _lastState = new Map<string, string>();

	/** 操作の前に呼ぶ。E1 なら記録を始め、I1 ならページとダウンロードの一覧を控える。 */
	async before(host: IParadisObserveHost, options: IParadisObserveOptions, observe: 'changes' | 'none' | 'snapshot', settleMs: number): Promise<IBefore> {
		const name = `__paraObserve_${generateUuid().replace(/-/g, '')}`;
		const pages = paradisParseListPages(await host.listPages().catch(() => undefined));
		const downloads = options.state ? await host.downloads().catch(() => undefined) : undefined;
		let installed = false;
		let url: string | undefined;
		let title: string | undefined;
		if (options.settle && observe === 'changes' && settleMs >= 0 && pages?.dialog === undefined && host.isCurrent()) {
			const info = evaluated<{ url?: unknown; title?: unknown }>(await host.evaluate(paradisObserveInstallFunction(name)).catch(() => undefined));
			if (info) {
				installed = true;
				url = typeof info.url === 'string' ? info.url : undefined;
				title = typeof info.title === 'string' ? info.title : undefined;
			}
		}
		return { name, installed, url, title, pages, downloads };
	}

	/** 操作が成功した後に呼ぶ。添える文（無ければ undefined）。 */
	async after(host: IParadisObserveHost, stateKey: string, options: IParadisObserveOptions, before: IBefore, observe: 'changes' | 'none' | 'snapshot', settleMs: number): Promise<string | undefined> {
		const parts: string[] = [];
		let pages = paradisParseListPages(await host.listPages().catch(() => undefined));
		if (options.settle && observe !== 'none' && pages?.dialog === undefined) {
			const settled = await this._settle(host, before.name, settleMs);
			if (settled.dialog !== undefined) {
				pages = { pages: pages?.pages ?? [], dialog: settled.dialog };
			} else if (observe === 'snapshot') {
				parts.push(`${settleHead(settled)} Page snapshot:`);
				const snapshot = await host.snapshot().catch(() => undefined);
				const text = isRecord(snapshot) && Array.isArray(snapshot.content) ? snapshot.content.filter(item => isRecord(item) && item.type === 'text').map(item => (item as { text: string }).text).join('\n') : '';
				if (text) {
					parts.push(text);
				}
			} else if (before.installed) {
				// 読む直前にもダイアログを確かめる（開いていれば変化は読まず、ダイアログだけを伝える）
				const latest = paradisParseListPages(await host.listPages().catch(() => undefined));
				if (latest?.dialog !== undefined) {
					pages = latest;
				} else {
					const collected = evaluated<ICollected>(await host.evaluate(paradisObserveCollectFunction(before.name, MAX_LINES)).catch(() => undefined));
					parts.push(paradisFormatChanges(before, collected, settled));
					pages = latest ?? pages;
				}
			}
		}
		if (options.state) {
			const state = await this._state(host, stateKey, before, pages);
			if (state) {
				parts.push(state);
			}
		} else if (pages?.dialog !== undefined) {
			parts.push(`A JavaScript dialog is open (${pages.dialog}). Handle it with handle_dialog before anything else on this page.`);
		}
		return parts.length > 0 ? parts.join('\n\n') : undefined;
	}

	forget(stateKeyPrefix: string): void {
		for (const key of [...this._lastState.keys()]) {
			if (key.startsWith(stateKeyPrefix)) {
				this._lastState.delete(key);
			}
		}
	}

	/**
	 * 操作の後、DOM の変化が {@link QUIET_MS} 止まり、読み込み中の印が消え、通信が落ち着くまで（`settleMs` まで）待つ。
	 * ページの中では待たず、{@link POLL_MS} ごとに記録を読む。読むのは待たない評価（vendored の PARA-PATCH
	 * `paraCodeObserve`）で、ダイアログが開いていれば断られる（閉じない）。
	 */
	private async _settle(host: IParadisObserveHost, name: string, settleMs: number): Promise<{ readonly quiet: boolean; readonly waited: number; readonly navigated: boolean; readonly dialog?: string }> {
		const start = host.now();
		let navigated = false;
		let quiet = settleMs === 0;
		let dialog: string | undefined;
		while (settleMs > 0 && host.isCurrent()) {
			const result = await host.evaluate(paradisObserveReadFunction(name)).catch(() => undefined);
			const value = evaluated<{ age?: unknown; ready?: unknown; busy?: unknown; navigated?: unknown }>(result);
			if (value === undefined) {
				if (paradisIsDialogOpenFailure(result)) {
					// ダイアログが開いた。中身は list_pages で読む
					dialog = paradisParseListPages(await host.listPages().catch(() => undefined))?.dialog ?? 'a JavaScript dialog';
					break;
				}
				// 遷移の途中（文書が入れ替わった）ならやり直す。それ以外の失敗は待つのをやめる
				if (result !== undefined && !paradisIsTransientEvaluateFailure(result)) {
					break;
				}
				navigated = true;
			} else {
				navigated = navigated || value.navigated === true;
				const network = host.network();
				const networkIdle = network === undefined || (network.inflight === 0 && (network.quietMs === undefined || network.quietMs >= QUIET_MS));
				if (value.ready === true && typeof value.age === 'number' && value.age >= QUIET_MS && host.now() - start >= QUIET_MS && value.busy !== true && networkIdle) {
					quiet = true;
					break;
				}
			}
			if (host.now() - start >= settleMs) {
				break;
			}
			await host.sleep(POLL_MS);
		}
		return { quiet, waited: host.now() - start, navigated, ...(dialog !== undefined ? { dialog } : {}) };
	}



	private async _state(host: IParadisObserveHost, stateKey: string, before: IBefore, pages: IPagesState | undefined): Promise<string | undefined> {
		const tabs = await host.tabs().catch(() => undefined);
		const downloadsAfter = await host.downloads().catch(() => undefined);
		const lines: string[] = [];
		if (tabs && tabs.length > 0) {
			lines.push(`Your tabs: ${tabs.map(tab => `${tab.tabId}${tab.current ? ' (current)' : ''}${tab.shared ? ' (shared by the user)' : ''} ${JSON.stringify(tab.title.slice(0, 80))} ${tab.url}`).join('; ')}`);
		}
		const beforeIndexes = new Set((before.pages?.pages ?? []).map(page => page.index));
		// 操作の前の一覧が取れなかった（ダイアログが開いていると空になる）ときは、開いたページを数えない
		const opened = before.pages === undefined || before.pages.pages.length === 0 ? [] : (pages?.pages ?? []).filter(page => !beforeIndexes.has(page.index));
		if ((pages?.pages.length ?? 0) > 1 || opened.length > 0) {
			lines.push(`Pages in this tab's browser: ${(pages?.pages ?? []).map(page => `pageId ${page.index}${page.selected ? ' (selected)' : ''}${opened.includes(page) ? ' (opened by this action)' : ''} ${JSON.stringify(page.title.slice(0, 80))} ${page.url}`).join('; ')}`);
		}
		if (opened.length > 0) {
			lines.push('This action opened a new page. It is not one of your tabs: read it with select_page (pageId) or open its URL with navigate_page / open_browser_tab.');
		}
		const newDownloads: string[] = [];
		if (downloadsAfter && before.downloads) {
			for (const [file, size] of downloadsAfter) {
				if (before.downloads.get(file) !== size) {
					newDownloads.push(`${file} (${size} bytes)`);
				}
			}
		}
		if (newDownloads.length > 0) {
			lines.push(`New download: ${newDownloads.slice(0, 5).join(', ')}. Read it with read_download.`);
		}
		if (pages?.dialog !== undefined) {
			lines.push(`Open dialog: ${pages.dialog}. Handle it with handle_dialog before anything else on this page.`);
		}
		// 新しいダウンロードとページは毎回伝える。タブの一覧だけが前回と同じなら省く
		const key = JSON.stringify([tabs?.map(tab => [tab.tabId, tab.url, tab.title, tab.current]), pages?.pages.map(page => [page.index, page.url, page.selected])]);
		const unchanged = this._lastState.get(stateKey) === key && opened.length === 0 && newDownloads.length === 0 && pages?.dialog === undefined;
		this._lastState.set(stateKey, key);
		if (unchanged || lines.length === 0) {
			return undefined;
		}
		return `[Browser state]\n${lines.join('\n')}`;
	}
}

function settleHead(settled: { readonly quiet: boolean; readonly waited: number }): string {
	return settled.quiet
		? `[Page after the action] Settled after ${settled.waited} ms.`
		: `[Page after the action] Still changing or loading after ${settled.waited} ms (the wait limit); use wait_until if you expect a slower update.`;
}

/** 集めた変化を文にする。 */
export function paradisFormatChanges(before: { readonly url?: string; readonly title?: string }, collected: ICollected | undefined, settled: { readonly quiet: boolean; readonly waited: number; readonly navigated: boolean }): string {
	const head = settleHead(settled);
	if (collected === undefined) {
		return `${head} (Para Code could not read the changes; call take_snapshot if you need them.)`;
	}
	const lines = [head];
	if (collected.missing === true || collected.navigated === true || settled.navigated) {
		lines.push(`A new document loaded: ${collected.url ?? '?'} ${JSON.stringify(collected.title ?? '')}`);
		if (collected.text) {
			lines.push(`Start of its text: ${collected.text}`);
		}
		return lines.join('\n');
	}
	if (collected.url !== undefined && before.url !== undefined && collected.url !== before.url) {
		lines.push(`URL: ${before.url} -> ${collected.url}`);
	}
	if (collected.title !== undefined && before.title !== undefined && collected.title !== before.title) {
		lines.push(`Title: ${JSON.stringify(before.title)} -> ${JSON.stringify(collected.title)}`);
	}
	const section = (label: string, items: readonly string[] | undefined) => {
		if (items && items.length > 0) {
			lines.push(`${label}:`, ...items.map(item => `- ${item}`));
		}
	};
	section('Appeared', collected.added);
	section('Changed', collected.changed);
	section('Disappeared', collected.removed);
	if (collected.focus) {
		lines.push(`Focus: ${collected.focus}`);
	}
	if ((collected.more ?? 0) > 0) {
		lines.push(`(${collected.more} more changes not listed; call take_snapshot for the whole page.)`);
	}
	if (lines.length === 1) {
		lines.push('No visible change on the page.');
	}
	return lines.join('\n');
}
