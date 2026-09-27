/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の追加のブラウザ操作（B7）の shared process 側。ツールの引数を検証して、
// マウスは既存の入力の通り道（dispatchExactViewInput、フォーカス中は断る・カーソル演出あり）へ、
// タブへの上書き・PDF・ダウンロード・ハイライトは electron-main の口（paradisCdpTargetService.ts）へ渡す。
//
// サービス本体（paradisAgentBrowserService.ts）が済ませてから呼ぶこと:
//   - ペイントークンと ingress lease の確認
//   - 接続元の確認（pane か tunnel。どのツールも状態を変えるか、上書きの中身を返すため）
// ここでは「そのペインに共有されているタブ」だけを相手にし、await の後はバインドが変わっていないかを
// 毎回確かめる。

import { createHash } from 'crypto';
import { IParadisCdpInputDispatchResult, IParadisExactBrowserViewDescriptor } from '../common/paradisAgentBrowser.js';
import {
	IParadisAgentDownloadResult,
	IParadisHighlightRect,
	IParadisPageOverridesRequest,
	IParadisPageOverridesResult,
	IParadisPdfResult,
	PARADIS_PAGE_OPS_DEFAULT_HIGHLIGHT_MS,
	PARADIS_PAGE_OPS_MAX_HIGHLIGHT_MS,
	ParadisPageOpsFailure,
	paradisParseHeaderMap,
	paradisParseHeaderOrigins,
	paradisParseHttpCredentials,
	paradisParsePdfOptions,
	paradisParseRequestRules,
} from '../common/paradisBrowserPageOps.js';
import { PARADIS_PAGE_OPS_TOOL_NAMES } from './paradisBrowserPageOpsTools.js';
import { IParadisResolvedDropTarget } from './paradisFileDropUpload.js';

/** 追加のブラウザ操作のツール名。 */
export const PARADIS_PAGE_OPS_TOOL_NAME_SET: ReadonlySet<string> = new Set(PARADIS_PAGE_OPS_TOOL_NAMES);

/** このペインに共有されているタブ（サービスの IBindingEntry のうち使うもの）。同一性で比べる。 */
export interface IParadisPageOpsBinding {
	readonly exactView: IParadisExactBrowserViewDescriptor;
	readonly generation: number;
	readonly pageInfo: { readonly url: string; readonly title: string };
}

/** ツールの実行中にサービスから借りるもの。 */
export interface IParadisPageOpsCall {
	readonly token: string;
	readonly signal?: AbortSignal;
	/** ingress lease が古くなっていたら投げる。await の後に呼ぶ。 */
	requireCurrent(): void;
	/** uid の要素の中心座標などを内蔵 chrome-devtools-mcp の evaluate_script で求める。失敗は MCP のツールの結果（エラー）で返す。 */
	resolveElement(uid: string): Promise<{ readonly ok: true; readonly target: IParadisResolvedDropTarget } | { readonly ok: false; readonly result: unknown }>;
}

/** サービスが用意する口。 */
export interface IParadisPageOpsHost {
	binding(token: string): IParadisPageOpsBinding | undefined;
	readonly notBoundMessage: string;
	/** electron-main の PARADIS_CDP_TARGET_CHANNEL を呼ぶ。 */
	callMain<T>(method: string, args: unknown[]): Promise<T>;
	/** 既存の入力の通り道で1つ送る（キューに並び、ユーザーがそのタブを使っていれば断られる）。 */
	dispatchInput(token: string, binding: IParadisPageOpsBinding, method: string, paramsJson: string): Promise<IParadisCdpInputDispatchResult>;
	/** エージェントのネットワークの制限。有効でなければ undefined。 */
	networkFilter(): { isUriAllowed(url: string): boolean } | undefined;
}

type ToolResult = unknown;

function text(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }] };
}

function error(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

const BINDING_CHANGED = 'PARA_BROWSER_RETRYABLE: the page shared with this terminal pane changed while the tool was running; check get_shared_page and retry.';

/** ペイントークンから、electron-main へ渡す持ち主の名前（トークンそのものは渡さない）。 */
export function paradisPageOpsOwnerKey(token: string): string {
	return createHash('sha256').update(`paradis-page-ops\0${token}`).digest('hex').slice(0, 32);
}

// --- マウス -------------------------------------------------------------------------------------

export type ParadisMouseAction = 'move' | 'down' | 'up' | 'context_click' | 'middle_click' | 'drag' | 'wheel';
export type ParadisMouseButton = 'left' | 'middle' | 'right';

const MOUSE_ACTIONS: readonly ParadisMouseAction[] = ['move', 'down', 'up', 'context_click', 'middle_click', 'drag', 'wheel'];
const BUTTON_BITS: Readonly<Record<ParadisMouseButton, number>> = { left: 1, right: 2, middle: 4 };
const MODIFIER_BITS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MAX_COORDINATE = 100_000;
const MAX_WHEEL_DELTA = 100_000;
const MAX_STEPS = 50;
const DEFAULT_STEPS = 5;

/** ペインごとの、押したままのボタンと最後の位置。 */
export interface IParadisMouseState {
	readonly x: number;
	readonly y: number;
	/** 押しているボタンの組（CDP の buttons）。 */
	readonly buttons: number;
}

export interface IParadisMouseCommand {
	readonly method: 'Input.dispatchMouseEvent';
	readonly params: Readonly<Record<string, unknown>>;
}

function pressedButtonName(buttons: number): ParadisMouseButton | 'none' {
	return buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none';
}

function interpolate(from: { x: number; y: number }, to: { x: number; y: number }, steps: number): { x: number; y: number }[] {
	const points: { x: number; y: number }[] = [];
	for (let i = 1; i <= steps; i++) {
		points.push({ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps });
	}
	return points;
}

/**
 * 1回のマウス操作を `Input.dispatchMouseEvent` の列へ組み立てる（送るのは呼び出し側）。
 * `state` は前の操作で押したままのボタンと位置。返す `next` を次の操作へ渡す。
 */
export function paradisBuildMouseCommands(
	action: ParadisMouseAction,
	point: { x: number; y: number },
	options: { readonly to?: { x: number; y: number }; readonly button?: ParadisMouseButton; readonly deltaX?: number; readonly deltaY?: number; readonly modifiers?: number; readonly steps?: number },
	state: IParadisMouseState,
): { readonly commands: IParadisMouseCommand[]; readonly next: IParadisMouseState } {
	const modifiers = options.modifiers ?? 0;
	const withModifiers = (params: Record<string, unknown>) => modifiers !== 0 ? { ...params, modifiers } : params;
	const moved = (at: { x: number; y: number }, buttons: number): IParadisMouseCommand => ({
		method: 'Input.dispatchMouseEvent',
		params: withModifiers({ type: 'mouseMoved', x: at.x, y: at.y, button: pressedButtonName(buttons), buttons }),
	});
	const press = (at: { x: number; y: number }, button: ParadisMouseButton, buttons: number): IParadisMouseCommand => ({
		method: 'Input.dispatchMouseEvent',
		params: withModifiers({ type: 'mousePressed', x: at.x, y: at.y, button, buttons, clickCount: 1 }),
	});
	const release = (at: { x: number; y: number }, button: ParadisMouseButton, buttons: number): IParadisMouseCommand => ({
		method: 'Input.dispatchMouseEvent',
		params: withModifiers({ type: 'mouseReleased', x: at.x, y: at.y, button, buttons, clickCount: 1 }),
	});
	const steps = Math.max(1, Math.min(MAX_STEPS, Math.round(options.steps ?? DEFAULT_STEPS)));
	const commands: IParadisMouseCommand[] = [];
	switch (action) {
		case 'move': {
			for (const at of interpolate(state, point, steps)) {
				commands.push(moved(at, state.buttons));
			}
			return { commands, next: { x: point.x, y: point.y, buttons: state.buttons } };
		}
		case 'down': {
			const button = options.button ?? 'left';
			const buttons = state.buttons | BUTTON_BITS[button];
			commands.push(moved(point, state.buttons), press(point, button, buttons));
			return { commands, next: { x: point.x, y: point.y, buttons } };
		}
		case 'up': {
			const button = options.button ?? 'left';
			const buttons = state.buttons & ~BUTTON_BITS[button];
			commands.push(moved(point, state.buttons), release(point, button, buttons));
			return { commands, next: { x: point.x, y: point.y, buttons } };
		}
		case 'context_click':
		case 'middle_click': {
			const button: ParadisMouseButton = action === 'context_click' ? 'right' : 'middle';
			commands.push(moved(point, state.buttons), press(point, button, state.buttons | BUTTON_BITS[button]), release(point, button, state.buttons));
			return { commands, next: { x: point.x, y: point.y, buttons: state.buttons } };
		}
		case 'drag': {
			const to = options.to ?? point;
			const held = state.buttons | BUTTON_BITS.left;
			commands.push(moved(point, state.buttons), press(point, 'left', held));
			for (const at of interpolate(point, to, steps)) {
				commands.push(moved(at, held));
			}
			commands.push(release(to, 'left', state.buttons));
			return { commands, next: { x: to.x, y: to.y, buttons: state.buttons } };
		}
		case 'wheel': {
			commands.push(moved(point, state.buttons), {
				method: 'Input.dispatchMouseEvent',
				params: withModifiers({ type: 'mouseWheel', x: point.x, y: point.y, deltaX: options.deltaX ?? 0, deltaY: options.deltaY ?? 0 }),
			});
			return { commands, next: { x: point.x, y: point.y, buttons: state.buttons } };
		}
	}
}

function isCoordinate(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_COORDINATE;
}

// --- 本体 ---------------------------------------------------------------------------------------

export class ParadisBrowserPageOps {

	private readonly mouseStates = new Map<string, { readonly binding: IParadisPageOpsBinding; state: IParadisMouseState }>();
	/**
	 * 途中で断られて送れなかったボタンの離し（ペインごと）。ページに押したままのボタンを残さないよう、
	 * 次にそのタブへマウスの入力を送る前に送る。
	 */
	private readonly pendingReleases = new Map<string, { readonly binding: IParadisPageOpsBinding; readonly releases: Record<string, unknown>[] }>();

	constructor(private readonly host: IParadisPageOpsHost) { }

	isPageOpsTool(name: string): boolean {
		return PARADIS_PAGE_OPS_TOOL_NAME_SET.has(name);
	}

	/**
	 * ペインの共有が入れ替わった（世代が進んだ）。押したままのボタンを忘れ、electron-main へ
	 * そのペインがタブへ掛けた上書きを外させる（`generation` より前に掛けたもの）。
	 */
	releaseOwner(token: string, generation: number): void {
		this.mouseStates.delete(token);
		// 共有が変わった後は元のタブへ入力を送れないので、送れなかった離しは諦める（NOTES の限界）。
		this.pendingReleases.delete(token);
		void this.host.callMain('releasePageOverridesOwner', [paradisPageOpsOwnerKey(token), generation]).catch(() => undefined);
	}

	async call(call: IParadisPageOpsCall, name: string, rawArgs: unknown): Promise<ToolResult> {
		const binding = this.host.binding(call.token);
		if (!binding) {
			return error(this.host.notBoundMessage);
		}
		const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
		switch (name) {
			case 'mouse_action': return this.mouseAction(call, binding, args);
			case 'save_page_as_pdf': return this.savePdf(call, binding, args);
			case 'set_extra_http_headers': return this.setExtraHeaders(call, binding, args);
			case 'set_http_credentials': return this.setCredentials(call, binding, args);
			case 'set_request_rules': return this.setRules(call, binding, args);
			case 'get_page_network_overrides': return this.getOverrides(call, binding);
			case 'download_by_click': return this.downloadByClick(call, binding, args);
			case 'highlight_element': return this.highlight(call, binding, args);
			default: return error(`Unknown tool: ${name}`);
		}
	}

	private isCurrent(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding): boolean {
		call.requireCurrent();
		return this.host.binding(call.token) === binding;
	}

	/** uid か x/y から、操作する点を求める。`needsHit` は押す操作（覆われている要素へは押さない）。 */
	private async resolvePoint(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>, keys: { uid: string; x: string; y: string }, needsHit: boolean): Promise<{ ok: true; point: { x: number; y: number }; element?: IParadisResolvedDropTarget } | { ok: false; result: ToolResult }> {
		const uid = args[keys.uid];
		const x = args[keys.x];
		const y = args[keys.y];
		if (typeof uid === 'string' && uid.length > 0) {
			if (x !== undefined || y !== undefined) {
				return { ok: false, result: error(`Give either "${keys.uid}" or "${keys.x}"/"${keys.y}", not both.`) };
			}
			const resolved = await call.resolveElement(uid);
			if (!this.isCurrent(call, binding)) {
				return { ok: false, result: error(BINDING_CHANGED) };
			}
			if (!resolved.ok) {
				return { ok: false, result: resolved.result };
			}
			const target = resolved.target;
			if (target.width <= 0 || target.height <= 0) {
				return { ok: false, result: error(`The element (uid "${uid}") has zero size, so it may not be visible. Take a fresh take_snapshot and retry.`) };
			}
			if (!target.inMainFrame) {
				return { ok: false, result: error(`The element (uid "${uid}") is inside an iframe. Coordinates of trusted mouse input are relative to the main frame, so use x/y from a screenshot instead.`) };
			}
			if (target.x < 0 || target.y < 0 || target.x >= target.viewportWidth || target.y >= target.viewportHeight) {
				return { ok: false, result: error(`The element (uid "${uid}") is outside the visible viewport. Take a fresh take_snapshot after scrolling settles and retry.`) };
			}
			if (needsHit && target.occluded) {
				return { ok: false, result: error(`The element (uid "${uid}") is covered by another element at its center (for example a sticky header or a modal), so the input would land on that element. Dismiss it and retry.`) };
			}
			return { ok: true, point: { x: target.x, y: target.y }, element: target };
		}
		if (isCoordinate(x) && isCoordinate(y)) {
			return { ok: true, point: { x, y } };
		}
		return { ok: false, result: error(`Give "${keys.uid}" (from take_snapshot) or both "${keys.x}" and "${keys.y}" (non-negative CSS pixel coordinates of the viewport).`) };
	}

	/** 前に送れなかったボタンの離しを送る。送れなければその理由を返す。 */
	private async flushPendingReleases(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding): Promise<string | undefined> {
		const pending = this.pendingReleases.get(call.token);
		if (!pending) {
			return undefined;
		}
		if (pending.binding !== binding) {
			this.pendingReleases.delete(call.token);
			return undefined;
		}
		while (pending.releases.length > 0) {
			const result = await this.host.dispatchInput(call.token, binding, 'Input.dispatchMouseEvent', JSON.stringify(pending.releases[0]));
			if (result.status !== 'success') {
				return `a mouse button pressed by an earlier action is still held and could not be released yet (${result.message})`;
			}
			pending.releases.shift();
		}
		this.pendingReleases.delete(call.token);
		return undefined;
	}

	/**
	 * 列を順に送る。途中で断られたら、この列で押したまま離せていないボタンを離しに行き、それも断られたら
	 * 次の入力の前に送るよう覚える（ページにドラッグ中・押下中の状態を残さない）。
	 */
	private async dispatchAll(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, commands: readonly IParadisMouseCommand[], pauseMs: number): Promise<{ ok: true } | { ok: false; sent: number; message: string }> {
		const pressed = new Map<string, Record<string, unknown>>();
		const releaseOutstanding = async () => {
			if (pressed.size === 0) {
				return;
			}
			const releases = [...pressed.values()].map(press => ({ ...press, type: 'mouseReleased', buttons: 0 }));
			const unsent: Record<string, unknown>[] = [];
			for (const release of releases) {
				if (unsent.length > 0 || this.host.binding(call.token) !== binding) {
					unsent.push(release);
					continue;
				}
				const result = await this.host.dispatchInput(call.token, binding, 'Input.dispatchMouseEvent', JSON.stringify(release)).catch(() => undefined);
				if (result?.status !== 'success') {
					unsent.push(release);
				}
			}
			if (unsent.length > 0 && this.host.binding(call.token) === binding) {
				this.pendingReleases.set(call.token, { binding, releases: unsent });
			}
		};
		for (const [index, command] of commands.entries()) {
			if (!this.isCurrent(call, binding)) {
				await releaseOutstanding();
				return { ok: false, sent: index, message: BINDING_CHANGED };
			}
			const result = await this.host.dispatchInput(call.token, binding, command.method, JSON.stringify(command.params));
			if (result.status !== 'success') {
				await releaseOutstanding();
				return { ok: false, sent: index, message: result.message };
			}
			const button = typeof command.params.button === 'string' ? command.params.button : '';
			if (command.params.type === 'mousePressed') {
				pressed.set(button, { x: command.params.x, y: command.params.y, button, clickCount: 1 });
			} else if (command.params.type === 'mouseReleased') {
				pressed.delete(button);
			}
			if (pauseMs > 0 && index < commands.length - 1) {
				await new Promise<void>(resolve => setTimeout(resolve, pauseMs));
			}
		}
		return { ok: true };
	}

	private mouseState(token: string, binding: IParadisPageOpsBinding): IParadisMouseState {
		const entry = this.mouseStates.get(token);
		return entry && entry.binding === binding ? entry.state : { x: 0, y: 0, buttons: 0 };
	}

	private async mouseAction(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>): Promise<ToolResult> {
		const action = args.action;
		if (typeof action !== 'string' || !(MOUSE_ACTIONS as readonly string[]).includes(action)) {
			return error(`"action" must be one of ${MOUSE_ACTIONS.join(', ')}.`);
		}
		const mouseAction = action as ParadisMouseAction;
		const button = args.button ?? 'left';
		if (button !== 'left' && button !== 'middle' && button !== 'right') {
			return error('"button" must be "left", "middle" or "right".');
		}
		let modifiers = 0;
		if (args.modifiers !== undefined) {
			if (!Array.isArray(args.modifiers) || args.modifiers.some(modifier => typeof modifier !== 'string' || MODIFIER_BITS[modifier] === undefined)) {
				return error('"modifiers" must be an array of "Alt", "Control", "Meta", "Shift".');
			}
			modifiers = args.modifiers.reduce((bits: number, modifier: string) => bits | MODIFIER_BITS[modifier], 0);
		}
		const steps = args.steps;
		if (steps !== undefined && (typeof steps !== 'number' || !Number.isFinite(steps) || steps < 1 || steps > MAX_STEPS)) {
			return error(`"steps" must be a number from 1 to ${MAX_STEPS}.`);
		}
		const deltaX = args.delta_x ?? 0;
		const deltaY = args.delta_y ?? 0;
		if (mouseAction === 'wheel') {
			if (typeof deltaX !== 'number' || typeof deltaY !== 'number' || !Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > MAX_WHEEL_DELTA || Math.abs(deltaY) > MAX_WHEEL_DELTA || (deltaX === 0 && deltaY === 0)) {
				return error('wheel needs a non-zero "delta_x" and/or "delta_y" (CSS pixels).');
			}
		}
		const stuck = await this.flushPendingReleases(call, binding);
		if (stuck !== undefined) {
			return error(`mouse_action ${mouseAction} was not sent: ${stuck}. Retry when the user is not using the page.`);
		}
		const pressing = mouseAction === 'down' || mouseAction === 'context_click' || mouseAction === 'middle_click' || mouseAction === 'drag';
		const from = await this.resolvePoint(call, binding, args, { uid: 'uid', x: 'x', y: 'y' }, pressing);
		if (!from.ok) {
			return from.result;
		}
		let to: { x: number; y: number } | undefined;
		if (mouseAction === 'drag') {
			const resolved = await this.resolvePoint(call, binding, args, { uid: 'to_uid', x: 'to_x', y: 'to_y' }, false);
			if (!resolved.ok) {
				return resolved.result;
			}
			to = resolved.point;
		}
		const state = this.mouseState(call.token, binding);
		const built = paradisBuildMouseCommands(mouseAction, from.point, {
			to,
			button,
			deltaX: deltaX as number,
			deltaY: deltaY as number,
			modifiers,
			steps: steps as number | undefined,
		}, state);
		const sent = await this.dispatchAll(call, binding, built.commands, mouseAction === 'drag' || mouseAction === 'move' ? 16 : 0);
		if (!sent.ok) {
			// 押したまま止まったボタンは dispatchAll が離しに行く（送れなければ次の入力の前に送る）。
			return error(`mouse_action ${mouseAction} was not completed: ${sent.message}`);
		}
		this.mouseStates.set(call.token, { binding, state: built.next });
		const where = `(${Math.round(from.point.x)}, ${Math.round(from.point.y)})`;
		switch (mouseAction) {
			case 'move': return text(`Moved the pointer to ${where}.`);
			case 'down': return text(`Pressed the ${button} button at ${where}. Call mouse_action with action "up" to release it.`);
			case 'up': return text(`Released the ${button} button at ${where}.`);
			case 'context_click': return text(`Right-clicked at ${where}. Take a snapshot or screenshot to see the context menu (menus drawn by the operating system are not visible to the page tools).`);
			case 'middle_click': return text(`Middle-clicked at ${where}.`);
			case 'drag': return text(`Dragged from ${where} to (${Math.round(to!.x)}, ${Math.round(to!.y)}).`);
			case 'wheel': return text(`Scrolled by (${deltaX}, ${deltaY}) over ${where}.`);
		}
	}

	private async savePdf(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>): Promise<ToolResult> {
		const options = paradisParsePdfOptions(args, binding.pageInfo.title || 'page');
		if (!options.ok) {
			return error(options.error);
		}
		const result = await this.host.callMain<IParadisPdfResult>('printExactViewToPdf', [binding.exactView, JSON.stringify(options.value)]);
		call.requireCurrent();
		if (!result.ok) {
			return error(this.failureMessage('save_page_as_pdf', result.reason, result.message));
		}
		return text(`Saved the page as a PDF: ${result.path} (${result.bytes} bytes). It is listed in Para Code's download list as saved by an agent.`);
	}

	private async applyOverrides(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, request: IParadisPageOverridesRequest, label: string): Promise<IParadisPageOverridesResult | ToolResult> {
		const result = await this.host.callMain<IParadisPageOverridesResult>('applyExactViewPageOverrides', [binding.exactView, paradisPageOpsOwnerKey(call.token), binding.generation, JSON.stringify(request)]);
		if (!this.isCurrent(call, binding)) {
			return error(BINDING_CHANGED);
		}
		if (!result.ok) {
			return error(this.failureMessage(label, result.reason, result.message));
		}
		return result;
	}

	private async setExtraHeaders(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>): Promise<ToolResult> {
		if (args.headers === undefined) {
			return error('"headers" is required (an empty object removes the extra headers).');
		}
		const headers = paradisParseHeaderMap(args.headers, 'request', 'headers');
		if (!headers.ok) {
			return error(headers.error);
		}
		const origins = paradisParseHeaderOrigins(args.origins);
		if (!origins.ok) {
			return error(origins.error);
		}
		const names = Object.keys(headers.value);
		const applied = await this.applyOverrides(call, binding, { extraHeaders: names.length > 0 ? { headers: headers.value, origins: origins.value } : null }, 'set_extra_http_headers');
		if (!isOverridesResult(applied)) {
			return applied;
		}
		const sentTo = applied.summary.extraHeaderOrigins ?? [];
		return text(names.length > 0
			? `Requests of the shared tab to ${sentTo.join(', ')} now carry these extra headers: ${names.join(', ')}. Requests to any other host (CDNs, analytics, other sites) do not. The browser cache and service workers are bypassed for that tab while overrides are set.`
			: 'Removed the extra headers of the shared tab.');
	}

	private async setCredentials(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>): Promise<ToolResult> {
		let request: IParadisPageOverridesRequest;
		if (args.clear === true) {
			request = { credentials: null };
		} else {
			const credentials = paradisParseHttpCredentials({ origin: args.origin, username: args.username, password: args.password });
			if (!credentials.ok) {
				return error(credentials.error);
			}
			request = { credentials: credentials.value };
		}
		const applied = await this.applyOverrides(call, binding, request, 'set_http_credentials');
		if (!isOverridesResult(applied)) {
			return applied;
		}
		return text(request.credentials
			? `The shared tab now answers HTTP authentication prompts from ${request.credentials.origin} with the given user name and password (at most twice per realm and minute, so a wrong password does not loop). Reload or navigate the page to use them.`
			: 'Removed the HTTP credentials of the shared tab.');
	}

	private async setRules(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>): Promise<ToolResult> {
		const rules = paradisParseRequestRules(args.rules);
		if (!rules.ok) {
			return error(rules.error);
		}
		// 行き先がエージェントのネットワークの制限に掛かる redirect は、置く前に断る。置いても
		// ブラウザが辿る要求は制限に掛かるが、黙って失敗させるより理由を返す。
		const filter = this.host.networkFilter();
		if (filter) {
			const blocked = rules.value.find(rule => rule.action === 'redirect' && !filter.isUriAllowed(rule.redirectUrl ?? ''));
			if (blocked) {
				return error(`The redirect target ${blocked.redirectUrl} is blocked by the agent network restrictions of Para Code, so this rule cannot be set.`);
			}
		}
		const applied = await this.applyOverrides(call, binding, { rules: rules.value.length > 0 ? rules.value : null }, 'set_request_rules');
		if (!isOverridesResult(applied)) {
			return applied;
		}
		return text(rules.value.length > 0
			? `Set ${rules.value.length} request rule(s) on the shared tab. They apply to requests made from now on (reload the page to apply them to its resources). Use get_page_network_overrides to see how many requests each rule matched.`
			: 'Removed the request rules of the shared tab.');
	}

	private async getOverrides(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding): Promise<ToolResult> {
		const result = await this.host.callMain<IParadisPageOverridesResult>('getExactViewPageOverrides', [binding.exactView, paradisPageOpsOwnerKey(call.token)]);
		if (!this.isCurrent(call, binding)) {
			return error(BINDING_CHANGED);
		}
		if (!result.ok) {
			return error(this.failureMessage('get_page_network_overrides', result.reason, result.message));
		}
		return text(JSON.stringify(result.summary, null, 2));
	}

	private async downloadByClick(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>): Promise<ToolResult> {
		const timeoutSeconds = args.timeout_seconds ?? 30;
		if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 50) {
			return error('"timeout_seconds" must be a number from 5 to 50.');
		}
		const stuck = await this.flushPendingReleases(call, binding);
		if (stuck !== undefined) {
			return error(`download_by_click did not click: ${stuck}. Retry when the user is not using the page.`);
		}
		const point = await this.resolvePoint(call, binding, args, { uid: 'uid', x: 'x', y: 'y' }, true);
		if (!point.ok) {
			return point.result;
		}
		const startedAt = Date.now();
		const totalMs = timeoutSeconds * 1000;
		const expectationId = await this.host.callMain<string | null>('expectExactViewDownload', [binding.exactView, Math.min(15_000, totalMs)]);
		if (!this.isCurrent(call, binding)) {
			if (expectationId) {
				void this.host.callMain('cancelExactViewDownload', [expectationId]).catch(() => undefined);
			}
			return error(BINDING_CHANGED);
		}
		if (!expectationId) {
			return error(this.failureMessage('download_by_click', 'unavailable'));
		}
		const state = this.mouseState(call.token, binding);
		const { commands } = paradisBuildMouseCommands('down', point.point, { button: 'left' }, state);
		const up = paradisBuildMouseCommands('up', point.point, { button: 'left' }, { ...state, buttons: state.buttons | 1 });
		const sent = await this.dispatchAll(call, binding, [...commands, ...up.commands.slice(1)], 0);
		if (!sent.ok) {
			void this.host.callMain('cancelExactViewDownload', [expectationId]).catch(() => undefined);
			return error(`download_by_click could not click: ${sent.message}`);
		}
		const onAbort = () => void this.host.callMain('cancelExactViewDownload', [expectationId]).catch(() => undefined);
		call.signal?.addEventListener('abort', onAbort, { once: true });
		let result: IParadisAgentDownloadResult;
		try {
			result = await this.host.callMain<IParadisAgentDownloadResult>('awaitExactViewDownload', [expectationId, Math.max(0, totalMs - (Date.now() - startedAt))]);
		} finally {
			call.signal?.removeEventListener('abort', onAbort);
		}
		call.requireCurrent();
		if (!result.ok) {
			return error(this.failureMessage('download_by_click', result.reason, result.message));
		}
		if (!result.started) {
			return error('The click was sent, but no download started within 15 seconds. The element may open a page instead of downloading (check with take_snapshot), or need a different element.');
		}
		const size = result.totalBytes > 0 ? `${result.receivedBytes} of ${result.totalBytes} bytes` : `${result.receivedBytes} bytes`;
		switch (result.state) {
			case 'completed':
				return text(`Downloaded "${result.fileName}" (${size}) to ${result.path}. It is listed in Para Code's download list as downloaded by an agent (the user is offered "Show in Folder", not "Open").`);
			case 'progressing':
				return text(result.path
					? `The download of "${result.fileName}" is still in progress (${size}); it is being saved to ${result.path}.`
					: `The download of "${result.fileName}" started, but Para Code is set to ask the user where to save it, so it waits for the user.`);
			case 'cancelled':
				return error(`The download of "${result.fileName}" was cancelled.`);
			case 'interrupted':
				return error(`The download of "${result.fileName}" failed (${size}).`);
		}
	}

	private async highlight(call: IParadisPageOpsCall, binding: IParadisPageOpsBinding, args: Record<string, unknown>): Promise<ToolResult> {
		if (args.clear === true) {
			await this.host.callMain<boolean>('highlightExactView', [binding.exactView, null, 0]);
			call.requireCurrent();
			return text('Removed the highlight.');
		}
		const duration = args.duration_seconds ?? PARADIS_PAGE_OPS_DEFAULT_HIGHLIGHT_MS / 1000;
		if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 1 || duration * 1000 > PARADIS_PAGE_OPS_MAX_HIGHLIGHT_MS) {
			return error(`"duration_seconds" must be a number from 1 to ${PARADIS_PAGE_OPS_MAX_HIGHLIGHT_MS / 1000}.`);
		}
		let rect: IParadisHighlightRect;
		if (typeof args.uid === 'string' && args.uid.length > 0) {
			const resolved = await this.resolvePoint(call, binding, args, { uid: 'uid', x: 'x', y: 'y' }, false);
			if (!resolved.ok) {
				return resolved.result;
			}
			const element = resolved.element!;
			rect = { x: element.x - element.width / 2, y: element.y - element.height / 2, width: element.width, height: element.height };
		} else {
			const { x, y, width, height } = args;
			if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height) || width < 1 || height < 1) {
				return error('Give "uid" (from take_snapshot) or "x", "y", "width" and "height" (CSS pixels of the viewport).');
			}
			rect = { x, y, width, height };
		}
		const shown = await this.host.callMain<boolean>('highlightExactView', [binding.exactView, rect, duration * 1000]);
		if (!this.isCurrent(call, binding)) {
			return error(BINDING_CHANGED);
		}
		return shown
			? text(`Highlighted (${Math.round(rect.x)}, ${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)}) for ${duration} seconds.`)
			: error('Para Code could not draw the highlight on the shared page. Retry once; the page may have been navigating.');
	}

	private failureMessage(tool: string, reason: ParadisPageOpsFailure, detail?: string): string {
		switch (reason) {
			case 'unavailable': return `PARA_BROWSER_RETRYABLE: ${tool} could not reach the shared browser tab (it may have been closed or re-shared). Check get_shared_page and retry.`;
			case 'userStorage': return `${tool}: this browser tab uses the user's own browser storage (the user shared one of their tabs), so headers, HTTP credentials and request rules are not applied to it: they would stay in the user's login and cache for their other tabs. Open a tab of your own with open_browser_tab (or a profile you created with open_browser_profile) and use ${tool} there.`;
			case 'ownedByAnotherPane': return `${tool}: another terminal pane has set headers, credentials or request rules on this browser tab. Only one pane can change a tab at a time; use your own tab (open_browser_tab) instead.`;
			case 'stale': return BINDING_CHANGED;
			case 'invalid': return `${tool}: ${detail ?? 'the request was rejected as invalid.'}`;
			case 'failed': return `${tool} failed${detail ? `: ${detail}` : '.'}`;
		}
	}
}

function isOverridesResult(value: unknown): value is Extract<IParadisPageOverridesResult, { ok: true }> {
	return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok: unknown }).ok === true;
}
