/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの種類のタブ（Q609・Q610、案 11）。「すべて・エージェント・タブ・スペース・コマンド」の 1 段を、入力の段の
// 下に足す。接頭辞（a・t・s・>）はタブの名前の前に小さく添え、`?` のヘルプは右端のアイコンのボタンにする。
//
// 包んでいる本家のファイル: src/vs/platform/quickinput/browser/quickInputController.ts（quick input の器）。器は本家が
// 1 つ作ってすべての quick input で使い回すので、横断ジャンプとコマンドパレットが開いている間だけ足し、閉じたら外す
// （paradisQuickInputLook.ts のヒントと同じく、器の DOM・キー・読み上げは変えない）。入力欄のフォーカスは動かさない:
// タブは Tab・Shift+Tab のキー割り当てで切り替え、マウスで押しても入力欄から抜けないよう mousedown を止める。
// 見た目は UI キットの切り替えの組（paradisSegmented.css）。

import '../../../browser/media/paradisSegmented.css';
import './media/paradisPalette.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { PARADIS_PALETTE_KIND_PREFIXES, PARADIS_PALETTE_KINDS, ParadisPaletteKind } from '../common/paradisCrossJump.js';

/** 種類のタブの段のクラス。 */
export const PARADIS_PALETTE_KINDS_CLASS = 'paradis-palette-kinds';

/** タブの名前。 */
export function paradisPaletteKindLabel(kind: ParadisPaletteKind): string {
	switch (kind) {
		case 'all': return localize('paradis.palette.kind.all', "すべて");
		case 'agent': return localize('paradis.palette.kind.agent', "エージェント");
		case 'editor': return localize('paradis.palette.kind.editor', "タブ");
		case 'space': return localize('paradis.palette.kind.space', "スペース");
		case 'command': return localize('paradis.palette.kind.command', "コマンド");
	}
}

/** 段に出す中身。 */
export interface IParadisPaletteKindsState {
	readonly selected: ParadisPaletteKind;
	/** 種類ごとの、今の入力に一致する件数。数えていない種類（コマンドなど）は出さない。 */
	readonly counts: Partial<Record<ParadisPaletteKind, number>>;
	/** 一致したエージェントのうち要対応（許可待ち・質問中）の数。1 以上ならエージェントの数を「要対応/全体」で警告の色にする。 */
	readonly attention: number;
	/** 右のプレビューの on/off。窓が狭くてプレビューを出せないときは undefined（ボタンを出さない）。 */
	readonly preview?: boolean;
	/** プレビューの切り替えのキーの表示（ボタンの説明に添える）。 */
	readonly previewKeybinding?: string;
}

/** タブの件数の文字。要対応があるエージェントだけ「要対応/全体」。 */
export function paradisPaletteKindCountLabel(kind: ParadisPaletteKind, state: IParadisPaletteKindsState): string | undefined {
	const count = state.counts[kind];
	if (count === undefined) {
		return undefined;
	}
	return kind === 'agent' && state.attention > 0 ? `${state.attention}/${count}` : String(count);
}

export interface IParadisPaletteKindsHandlers {
	/** タブを押した。 */
	onSelect(kind: ParadisPaletteKind): void;
	/** ヘルプのボタンを押した。 */
	onHelp(): void;
	/** プレビューの切り替えのボタンを押した。 */
	onTogglePreview?(): void;
}

interface IKindButton {
	readonly button: HTMLButtonElement;
	readonly count: HTMLElement;
}

/** 器の入力の段の下に置く種類のタブ。dispose で器から外す。 */
export class ParadisPaletteKindsBar extends Disposable {

	readonly element: HTMLElement;
	private readonly buttons = new Map<ParadisPaletteKind, IKindButton>();
	private readonly previewButton: HTMLButtonElement;
	private readonly previewIcon: HTMLElement;
	private readonly previewHover: IManagedHover;

	constructor(widget: HTMLElement, handlers: IParadisPaletteKindsHandlers, hoverService: IHoverService) {
		super();
		this.element = dom.$(`.${PARADIS_PALETTE_KINDS_CLASS}`);
		const header = [...widget.children].find(child => child.classList.contains('quick-input-header'));
		if (header) {
			header.after(this.element);
		} else {
			widget.prepend(this.element);
		}
		this._register({ dispose: () => this.element.remove() });

		const group = dom.append(this.element, dom.$('.paradis-seg.paradis-palette-kinds-tabs'));
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', localize('paradis.palette.kinds', "種類"));
		for (const kind of PARADIS_PALETTE_KINDS) {
			const button = dom.append(group, dom.$<HTMLButtonElement>('button.paradis-focus-ring-inset'));
			button.type = 'button';
			// 入力欄から Tab で止まらせない（Tab は種類の切り替えに使う）。マウスでは押せる。
			button.tabIndex = -1;
			button.dataset.kind = kind;
			const prefix = PARADIS_PALETTE_KIND_PREFIXES[kind];
			if (prefix) {
				const prefixElement = dom.append(button, dom.$('span.paradis-palette-kind-prefix'));
				prefixElement.textContent = prefix;
				prefixElement.setAttribute('aria-hidden', 'true');
			}
			dom.append(button, dom.$('span.paradis-palette-kind-label')).textContent = paradisPaletteKindLabel(kind);
			const count = dom.append(button, dom.$('span.paradis-palette-kind-count'));
			count.setAttribute('aria-hidden', 'true');
			this.buttons.set(kind, { button, count });
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => handlers.onSelect(kind)));
		}

		dom.append(this.element, dom.$('span.paradis-palette-kinds-grow'));
		dom.append(this.element, dom.$('span.paradis-palette-kinds-key')).textContent = localize('paradis.palette.kindsKey', "Tab で切り替え");

		this.previewButton = dom.append(this.element, dom.$<HTMLButtonElement>('button.paradis-palette-icon-button.paradis-palette-preview-toggle.paradis-focus-ring-inset'));
		this.previewButton.type = 'button';
		this.previewButton.tabIndex = -1;
		this.previewButton.hidden = true;
		this.previewIcon = dom.append(this.previewButton, dom.$(ThemeIcon.asCSSSelector(Codicon.layoutSidebarRight)));
		this.previewIcon.setAttribute('aria-hidden', 'true');
		this.previewHover = this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), this.previewButton, ''));
		this._register(dom.addDisposableListener(this.previewButton, dom.EventType.CLICK, () => handlers.onTogglePreview?.()));

		const help = dom.append(this.element, dom.$<HTMLButtonElement>('button.paradis-palette-icon-button.paradis-palette-help.paradis-focus-ring-inset'));
		help.type = 'button';
		help.tabIndex = -1;
		const helpLabel = localize('paradis.palette.help', "ヘルプ（? と打っても開きます）。「a 」「t 」「s 」で始まる名前を接頭辞にせずに探すときは、先頭に空白を入れます");
		this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), help, helpLabel));
		help.setAttribute('aria-label', helpLabel);
		dom.append(help, dom.$(ThemeIcon.asCSSSelector(Codicon.question))).setAttribute('aria-hidden', 'true');
		this._register(dom.addDisposableListener(help, dom.EventType.CLICK, () => handlers.onHelp()));

		// 押しても入力欄のフォーカスを奪わない（器の外へフォーカスが出ると本家が quick input を閉じる）
		this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_DOWN, event => event.preventDefault()));
	}

	update(state: IParadisPaletteKindsState): void {
		for (const [kind, { button, count }] of this.buttons) {
			const selected = kind === state.selected;
			button.setAttribute('aria-pressed', String(selected));
			const text = paradisPaletteKindCountLabel(kind, state);
			count.textContent = text ?? '';
			count.classList.toggle('hidden', text === undefined);
			count.classList.toggle('attention', kind === 'agent' && state.attention > 0);
			const label = paradisPaletteKindLabel(kind);
			button.setAttribute('aria-label', text === undefined ? label : localize('paradis.palette.kindWithCount', "{0}（{1} 件）", label, state.counts[kind] ?? 0));
		}
		this.previewButton.hidden = state.preview === undefined;
		this.previewButton.setAttribute('aria-pressed', String(!!state.preview));
		this.previewIcon.className = ThemeIcon.asClassName(state.preview ? Codicon.layoutSidebarRight : Codicon.layoutSidebarRightOff);
		const previewLabel = state.preview ? localize('paradis.palette.previewHide', "プレビューを隠す") : localize('paradis.palette.previewShow', "プレビューを出す");
		const previewTitle = state.previewKeybinding ? localize('paradis.palette.previewWithKey', "{0} ({1})", previewLabel, state.previewKeybinding) : previewLabel;
		this.previewHover.update(previewTitle);
		this.previewButton.setAttribute('aria-label', previewTitle);
	}
}
