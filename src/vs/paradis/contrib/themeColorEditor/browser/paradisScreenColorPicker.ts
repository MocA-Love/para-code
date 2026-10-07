/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「テーマの色: 画面から選ぶ」。マウスの下の要素を枠で囲み、そこに効いている色 ID を出す。
//
// 色 ID は CSS の `var(--vscode-…)` を逆引きして当てる。ページの CSS（同じオリジンなので cssRules を読める）から
// `--vscode-` を使う宣言を持つ規則を最初に 1 回だけ集め、要素と祖先に `element.matches()` で当たる規則と
// インラインの style から変数を拾う。TS 側で色を計算して直接入れている部品は、計算済みの色を
// 今のテーマの全色と突き合わせて「色が一致」として出す（同じ色の ID が複数出ることがある）。
// canvas で描いている所（ミニマップ・概要ルーラー・ターミナル）は DOM から当てられないので、一覧から選ぶ案内を出す。
// upstream の CSS が色を TS 側へ移すと候補が減る（ビルドは通ったまま精度が下がる）ので、取り込み時に手で確かめること。

import './media/paradisThemeColorEditor.css';
import * as dom from '../../../../base/browser/dom.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { getColorRegistry } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import {
	IParadisColorCandidate,
	IParadisCssDeclaration,
	paradisBuildCssVariableReverseMap,
	paradisCollectColorCandidates,
	ParadisColorRole,
	paradisStripPseudoElements,
} from '../common/paradisThemeColorModel.js';

const $ = dom.$;

/** 選んだ結果。色 ID か、一覧を絞り込む語か、シンタックスの色を開く指示。 */
export type ParadisScreenPickResult =
	| { readonly kind: 'color'; readonly colorId: string }
	| { readonly kind: 'query'; readonly query: string }
	| { readonly kind: 'syntax' };

interface IRuleEntry {
	readonly selector: string;
	readonly declarations: readonly IParadisCssDeclaration[];
}

interface IRow {
	readonly label: string;
	readonly detail: string;
	readonly swatch?: string;
	readonly result: ParadisScreenPickResult;
}

const MAX_DEPTH = 6;
const MAX_CANDIDATES = 8;
const MAX_COLOR_MATCHES = 3;

/** canvas で描いている部品と、一覧を絞り込む語。 */
const CANVAS_PARTS: readonly { readonly selector: string; readonly query: string }[] = [
	{ selector: '.minimap', query: 'minimap' },
	{ selector: '.decorationsOverviewRuler', query: 'editorOverviewRuler' },
	{ selector: '.xterm', query: 'terminal' },
];

function roleLabel(role: ParadisColorRole): string {
	switch (role) {
		case 'background': return localize('paradis.themeColors.role.background', "背景");
		case 'foreground': return localize('paradis.themeColors.role.foreground', "文字");
		case 'border': return localize('paradis.themeColors.role.border', "枠線");
		case 'icon': return localize('paradis.themeColors.role.icon', "アイコン");
		case 'shadow': return localize('paradis.themeColors.role.shadow', "影");
		default: return localize('paradis.themeColors.role.other', "その他");
	}
}

/** `prop: value;` の並び（cssText）を宣言に分ける。shorthand の中の var() は longhand から読めないため cssText を使う。 */
function parseDeclarations(cssText: string): IParadisCssDeclaration[] {
	const result: IParadisCssDeclaration[] = [];
	if (!cssText.includes('--vscode-')) {
		return result;
	}
	for (const match of cssText.matchAll(/(?<property>[-a-zA-Z]+)\s*:\s*(?<value>[^;]+)/g)) {
		const property = match.groups?.property;
		const value = match.groups?.value;
		if (property && value && value.includes('--vscode-')) {
			result.push({ property: property.toLowerCase(), value });
		}
	}
	return result;
}

function collectRules(targetWindow: Window): IRuleEntry[] {
	// 補助ウィンドウの規則はそのウィンドウのコンストラクタで作られるので、instanceof はそのウィンドウのものと比べる。
	const win = targetWindow as Window & typeof globalThis;
	const result: IRuleEntry[] = [];
	const walk = (rules: CSSRuleList) => {
		for (const rule of Array.from(rules)) {
			if (rule instanceof win.CSSStyleRule) {
				const declarations = parseDeclarations(rule.style.cssText);
				if (declarations.length) {
					result.push({ selector: paradisStripPseudoElements(rule.selectorText), declarations });
				}
			}
			if (rule instanceof win.CSSMediaRule && rule.media.mediaText && !targetWindow.matchMedia(rule.media.mediaText).matches) {
				continue;
			}
			if (rule instanceof win.CSSGroupingRule) {
				walk(rule.cssRules);
			}
		}
	};
	for (const sheet of Array.from(targetWindow.document.styleSheets)) {
		try {
			walk(sheet.cssRules);
		} catch {
			// 別オリジンの CSS は読めない（読めないものは候補に出せないだけ）
		}
	}
	return result;
}

export class ParadisScreenColorPicker extends Disposable {

	private readonly targetDocument: Document;
	private readonly reverseMap = paradisBuildCssVariableReverseMap(getColorRegistry().getColors().map(color => color.id));
	private readonly rules: IRuleEntry[];
	private colorIndex: Map<string, string[]> | undefined;

	private readonly banner: HTMLElement;
	private readonly highlight: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly panelRows = this._register(new MutableDisposable<DisposableStore>());

	private current: HTMLElement | undefined;
	private pinned = false;
	private rows: IRow[] = [];
	private selected = 0;
	private readonly pendingFrame = this._register(new MutableDisposable());
	private lastPointer = { x: 0, y: 0 };

	constructor(
		private readonly targetWindow: Window,
		private readonly onPick: (result: ParadisScreenPickResult) => void,
		private readonly onEnd: () => void,
		@IThemeService private readonly themeService: IThemeService,
		@ILayoutService layoutService: ILayoutService,
	) {
		super();
		this.targetDocument = targetWindow.document;
		// テーマの色の CSS 変数（--vscode-…）は `.monaco-workbench` の上で定義されていて、body には無い。
		// 覆い・枠・候補の一覧を body に直接置くと変数が全部未定義になり、枠が消えて一覧の背景が透明になる
		// （影だけが暗く残り、下の文字に覆いがかかって見える）。必ずそのウィンドウのワークベンチの器に置く。
		// ワークベンチを持たない窓（body 自体にクラスを付ける窓など）では器が無いので body へ置く。
		const container: HTMLElement = layoutService.getContainer(targetWindow) ?? this.targetDocument.body;
		this.rules = collectRules(targetWindow);

		const store = this._register(new DisposableStore());
		const stylesheet = createStyleSheet(this.targetDocument.head, undefined, store);
		stylesheet.textContent = '* { cursor: crosshair !important; } .paradis-tce-screen-panel, .paradis-tce-screen-panel * { cursor: default !important; }';

		this.banner = dom.append(container, $('.paradis-tce-screen-banner', { role: 'status' }, localize('paradis.themeColors.screen.banner', "画面の色を変えたい場所をクリックしてください（Esc でやめる）")));
		this.highlight = dom.append(container, $('.paradis-tce-screen-highlight'));
		this.panel = dom.append(container, $('.paradis-tce-screen-panel', { role: 'listbox' }));
		this.panel.style.display = 'none';
		this._register({ dispose: () => { this.banner.remove(); this.highlight.remove(); this.panel.remove(); } });

		// 補助ウィンドウ（エディタの別ウィンドウ）で選んでいる途中にそのウィンドウが閉じたら終える。
		this._register(dom.addDisposableListener(targetWindow, 'unload', () => this.end()));
		this._register(dom.addDisposableListener(targetWindow, 'pagehide', () => this.end()));

		const swallow = (e: Event) => {
			if (this.isInPanel(e.target)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
		};
		for (const type of [dom.EventType.MOUSE_DOWN, dom.EventType.POINTER_DOWN, dom.EventType.POINTER_UP, dom.EventType.DBLCLICK, dom.EventType.CONTEXT_MENU, 'auxclick']) {
			this._register(dom.addDisposableListener(this.targetDocument, type, swallow, true));
		}
		this._register(dom.addDisposableListener(this.targetDocument, dom.EventType.MOUSE_UP, (e: MouseEvent) => {
			if (this.isInPanel(e.target)) {
				return;
			}
			swallow(e);
			if (e.button === 0 && dom.isHTMLElement(e.target)) {
				this.lastPointer = { x: e.clientX, y: e.clientY };
				this.inspect(e.target);
				this.pinned = true;
				this.renderPanel();
			}
		}, true));
		this._register(dom.addDisposableListener(this.targetDocument, dom.EventType.CLICK, swallow, true));
		this._register(dom.addDisposableListener(this.targetDocument, dom.EventType.MOUSE_MOVE, (e: MouseEvent) => {
			if (this.pinned || this.isInPanel(e.target) || !dom.isHTMLElement(e.target)) {
				return;
			}
			const target = e.target;
			this.lastPointer = { x: e.clientX, y: e.clientY };
			if (!this.pendingFrame.value) {
				this.pendingFrame.value = dom.scheduleAtNextAnimationFrame(this.targetWindow, () => {
					this.pendingFrame.clear();
					if (!this.pinned) {
						this.inspect(target);
					}
				});
			}
		}, true));
		this._register(dom.addDisposableListener(this.targetDocument, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.end();
				return;
			}
			if (!this.pinned || !this.rows.length) {
				return;
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
				this.selected = (this.selected + (e.key === 'ArrowDown' ? 1 : this.rows.length - 1)) % this.rows.length;
				this.renderPanel();
			} else if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				this.pick(this.rows[this.selected].result);
			}
		}, true));
	}

	private isInPanel(target: EventTarget | null): boolean {
		return dom.isHTMLElement(target) && this.panel.contains(target);
	}

	private end(): void {
		this.onEnd();
	}

	private pick(result: ParadisScreenPickResult): void {
		this.onPick(result);
		this.end();
	}

	private inspect(element: HTMLElement): void {
		if (element === this.current && !this.pinned) {
			this.positionPanel();
			return;
		}
		this.current = element;
		this.selected = 0;
		this.rows = this.computeRows(element);
		const box = element.getBoundingClientRect();
		this.highlight.style.left = `${box.left}px`;
		this.highlight.style.top = `${box.top}px`;
		this.highlight.style.width = `${box.width}px`;
		this.highlight.style.height = `${box.height}px`;
		this.renderPanel();
	}

	private computeRows(element: HTMLElement): IRow[] {
		const rows: IRow[] = [];
		const theme = this.themeService.getColorTheme();
		const swatch = (id: string) => theme.getColor(id)?.toString();

		const canvasPart = CANVAS_PARTS.find(part => !!element.closest(part.selector));
		if (element.tagName === 'CANVAS' || canvasPart) {
			const query = canvasPart?.query ?? '';
			rows.push({
				label: query
					? localize('paradis.themeColors.screen.canvasQuery', "一覧で「{0}」の色を開く", query)
					: localize('paradis.themeColors.screen.canvas', "一覧から選ぶ"),
				detail: localize('paradis.themeColors.screen.canvasDetail', "canvas で描いているため当てられません"),
				result: { kind: 'query', query },
			});
		}
		if (element.closest('.monaco-editor .view-lines')) {
			rows.push({
				label: localize('paradis.themeColors.screen.syntax', "シンタックスの色を開く"),
				detail: localize('paradis.themeColors.screen.syntaxDetail', "コードの文字"),
				result: { kind: 'syntax' },
			});
		}

		const levels: IParadisCssDeclaration[][] = [];
		let node: HTMLElement | null = element;
		for (let depth = 0; node && depth < MAX_DEPTH && node !== this.targetDocument.body; depth++, node = node.parentElement) {
			const declarations: IParadisCssDeclaration[] = [...parseDeclarations(node.style.cssText)];
			for (const rule of this.rules) {
				try {
					if (node.matches(rule.selector)) {
						declarations.push(...rule.declarations);
					}
				} catch {
					// matches() が受け付けないセレクタ（未知の疑似クラスなど）は飛ばす
				}
			}
			levels.push(declarations);
		}
		const candidates: IParadisColorCandidate[] = paradisCollectColorCandidates(levels, this.reverseMap, MAX_CANDIDATES);
		for (const candidate of candidates) {
			rows.push({
				label: candidate.id,
				detail: candidate.depth === 0 ? roleLabel(candidate.role) : localize('paradis.themeColors.screen.parent', "{0}（親）", roleLabel(candidate.role)),
				swatch: swatch(candidate.id),
				result: { kind: 'color', colorId: candidate.id },
			});
		}

		// 自分自身に CSS 変数の色が無いとき、計算済みの色をテーマの色と突き合わせる。
		if (!candidates.some(candidate => candidate.depth === 0)) {
			const seen = new Set(candidates.map(candidate => candidate.id));
			const style = this.targetWindow.getComputedStyle(element);
			let added = 0;
			for (const [value, role] of [[style.backgroundColor, 'background'], [style.color, 'foreground'], [style.borderTopColor, 'border']] as const) {
				for (const id of this.matchColor(value)) {
					if (added >= MAX_COLOR_MATCHES || seen.has(id)) {
						continue;
					}
					seen.add(id);
					added++;
					rows.push({
						label: id,
						detail: localize('paradis.themeColors.screen.colorMatch', "{0}・色が一致", roleLabel(role)),
						swatch: swatch(id),
						result: { kind: 'color', colorId: id },
					});
				}
			}
		}
		return rows;
	}

	/** 計算済みの色（`rgb(…)`）と同じ色を持つ ID。透明は一致させない（ほとんどの色と一致してしまう）。 */
	private matchColor(cssValue: string): string[] {
		let color: Color | null = null;
		try {
			color = Color.Format.CSS.parse(cssValue);
		} catch {
			color = null;
		}
		if (!color || color.rgba.a === 0) {
			return [];
		}
		if (!this.colorIndex) {
			this.colorIndex = new Map();
			const theme = this.themeService.getColorTheme();
			for (const { id, deprecationMessage } of getColorRegistry().getColors()) {
				const value = deprecationMessage ? undefined : theme.getColor(id);
				if (!value) {
					continue;
				}
				const key = Color.Format.CSS.formatHexA(value);
				const list = this.colorIndex.get(key) ?? [];
				list.push(id);
				this.colorIndex.set(key, list);
			}
		}
		return this.colorIndex.get(Color.Format.CSS.formatHexA(color)) ?? [];
	}

	private renderPanel(): void {
		const store = new DisposableStore();
		this.panelRows.value = store;
		dom.clearNode(this.panel);
		this.panel.style.display = '';
		this.panel.classList.toggle('pinned', this.pinned);
		dom.append(this.panel, $('.paradis-tce-screen-title', undefined, this.pinned
			? localize('paradis.themeColors.screen.pinnedTitle', "この場所の色（選ぶと編集）")
			: localize('paradis.themeColors.screen.title', "この場所の色（クリックで編集）")));
		if (!this.rows.length) {
			dom.append(this.panel, $('.paradis-tce-screen-empty', undefined, localize('paradis.themeColors.screen.empty', "この場所に効いているテーマの色は見つかりませんでした。親の要素か、一覧から選んでください")));
		}
		this.rows.forEach((row, index) => {
			const element = dom.append(this.panel, $('.paradis-tce-screen-row', { role: 'option', 'aria-selected': String(this.pinned && index === this.selected) }));
			element.classList.toggle('selected', this.pinned && index === this.selected);
			const sw = dom.append(element, $('span.paradis-tce-swatch'));
			if (row.swatch) {
				sw.style.setProperty('--paradis-tce-swatch', row.swatch);
			} else {
				sw.classList.add('none');
			}
			dom.append(element, $('span.paradis-tce-screen-id', undefined, row.label));
			dom.append(element, $('span.paradis-tce-screen-detail', undefined, row.detail));
			store.add(dom.addDisposableListener(element, dom.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.pick(row.result);
			}));
		});
		if (this.pinned) {
			const actions = dom.append(this.panel, $('.paradis-tce-screen-actions'));
			const parent = this.current?.parentElement;
			if (parent && parent !== this.targetDocument.body) {
				const button = dom.append(actions, $('button.paradis-tce-chip', { type: 'button' }, localize('paradis.themeColors.screen.parentButton', "親の要素へ")));
				store.add(dom.addDisposableListener(button, dom.EventType.CLICK, e => {
					e.stopPropagation();
					this.inspect(parent);
				}));
			}
			const resume = dom.append(actions, $('button.paradis-tce-chip', { type: 'button' }, localize('paradis.themeColors.screen.resume', "別の場所を選ぶ")));
			store.add(dom.addDisposableListener(resume, dom.EventType.CLICK, e => {
				e.stopPropagation();
				this.pinned = false;
				this.current = undefined;
				this.renderPanel();
			}));
			const cancel = dom.append(actions, $('button.paradis-tce-chip', { type: 'button' }, localize('paradis.themeColors.screen.cancel', "やめる")));
			store.add(dom.addDisposableListener(cancel, dom.EventType.CLICK, e => {
				e.stopPropagation();
				this.end();
			}));
		}
		this.positionPanel();
	}

	/** ポインタの右下に出し、画面の端ではみ出さないよう内側へ寄せる。 */
	private positionPanel(): void {
		const width = this.panel.offsetWidth;
		const height = this.panel.offsetHeight;
		const viewWidth = this.targetDocument.documentElement.clientWidth;
		const viewHeight = this.targetDocument.documentElement.clientHeight;
		let left = this.lastPointer.x + 16;
		let top = this.lastPointer.y + 16;
		if (left + width > viewWidth - 8) {
			left = Math.max(8, this.lastPointer.x - width - 16);
		}
		if (top + height > viewHeight - 8) {
			top = Math.max(8, this.lastPointer.y - height - 16);
		}
		this.panel.style.left = `${left}px`;
		this.panel.style.top = `${top}px`;
	}
}
