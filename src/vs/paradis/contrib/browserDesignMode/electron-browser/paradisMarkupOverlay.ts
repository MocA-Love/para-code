/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スクリーンショットへの書き込み（Markup、B2）。別タブの画像編集ではなく、ページを見たまま
// 同じ位置に描ける形にしている。
//
// ボタンを押すとページのスクリーンショットを撮り、同じ位置に静止画として重ね、その上に浮いた
// 道具バーで描く。描いている間ページは静止画なので、動画や読み込み中の表示で絵がずれない。
//
// 内蔵ブラウザのページはネイティブのビュー（WebContentsView）で、DOM の z-index では上に出せない。
// この重ね板のクラス名 `paradis-markup-overlay` を overlayManager.ts の OVERLAY_DEFINITIONS に
// 登録してあり、重ねている間はネイティブのビューが隠れる（NOTES.md「内蔵ブラウザの前面オーバー
// レイ機構」）。登録を外すと重ね板がページの裏に隠れて何も見えなくなる。
//
// 道具（ペン・蛍光ペン・矢印・四角・楕円・文字）、7色、太さ3段、取り消し・やり直しは Orca
// （stablyai/orca、MIT License、Copyright (c) 2026 Lovecast Inc.）の MarkupToolbar と同じ範囲。

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import {
	IParadisMarkupDocument,
	IParadisMarkupPoint,
	PARADIS_MARKUP_COLORS,
	PARADIS_MARKUP_DEFAULT_WIDTH,
	PARADIS_MARKUP_WIDTHS,
	ParadisMarkupShape,
	ParadisMarkupTool,
	paradisClearMarkup,
	paradisCommitMarkupShape,
	paradisCreateMarkupDocument,
	paradisDrawMarkupShapes,
	paradisIsMeaningfulMarkupShape,
	paradisMarkupFontSize,
	paradisRedoMarkup,
	paradisScaleMarkupShape,
	paradisUndoMarkup,
} from '../common/paradisMarkupModel.js';

/** 重ね板のクラス名（overlayManager.ts の OVERLAY_DEFINITIONS に登録済み）。 */
export const PARADIS_MARKUP_OVERLAY_CLASS = 'paradis-markup-overlay';

/** 書き込み面の位置（ブラウザのページが占めている矩形。重ね板の親要素からの CSS px）。 */
export interface IParadisMarkupArea {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

interface IToolDefinition {
	readonly tool: ParadisMarkupTool;
	readonly icon: ThemeIcon;
	readonly label: string;
}

/**
 * スクリーンショットの上で描く重ね板。閉じるときに `onClose` を1回だけ呼ぶ。渡すのは、描いた絵を
 * 合成した PNG（「注釈に追加」）か undefined（やめたとき・外から閉じたとき）。
 */
export class ParadisMarkupOverlay extends Disposable {

	private readonly root: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly image: HTMLImageElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly textInput: HTMLInputElement;
	private readonly toolButtons = new Map<ParadisMarkupTool, HTMLButtonElement>();
	private readonly colorButtons = new Map<string, HTMLButtonElement>();
	private readonly widthButtons = new Map<number, HTMLButtonElement>();
	private readonly undoButton: HTMLButtonElement;
	private readonly redoButton: HTMLButtonElement;
	private readonly clearButton: HTMLButtonElement;
	private readonly addButton: HTMLButtonElement;
	private readonly status: HTMLElement;
	private readonly imageUrl: string;

	private doc: IParadisMarkupDocument = paradisCreateMarkupDocument();
	private tool: ParadisMarkupTool = 'pen';
	private color = PARADIS_MARKUP_COLORS[0];
	private width = PARADIS_MARKUP_DEFAULT_WIDTH;
	private inProgress: ParadisMarkupShape | undefined;
	private textAt: IParadisMarkupPoint | undefined;
	private closed = false;

	constructor(
		parent: HTMLElement,
		private readonly area: IParadisMarkupArea,
		screenshot: Uint8Array,
		private readonly onClose: (png: Uint8Array | undefined) => void,
		@IHoverService private readonly hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		const targetWindow = getWindow(parent);
		this.imageUrl = targetWindow.URL.createObjectURL(new Blob([screenshot as Uint8Array<ArrayBuffer>], { type: 'image/png' }));

		this.root = append(parent, $(`.${PARADIS_MARKUP_OVERLAY_CLASS}`));
		this.root.tabIndex = -1;
		this.root.setAttribute('role', 'dialog');
		this.root.setAttribute('aria-label', localize('paradis.markup.aria', "スクリーンショットへの書き込み"));

		this.stage = append(this.root, $('.paradis-markup-stage'));
		this.stage.style.left = `${area.left}px`;
		this.stage.style.top = `${area.top}px`;
		this.stage.style.width = `${area.width}px`;
		this.stage.style.height = `${area.height}px`;
		this.image = append(this.stage, $<HTMLImageElement>('img.paradis-markup-image'));
		this.image.alt = '';
		this.image.src = this.imageUrl;
		this.canvas = append(this.stage, $<HTMLCanvasElement>('canvas.paradis-markup-canvas'));
		this.textInput = append(this.stage, $<HTMLInputElement>('input.paradis-markup-text-input'));
		this.textInput.type = 'text';
		this.textInput.placeholder = localize('paradis.markup.textPlaceholder', "文字を入力して Enter");
		this.textInput.style.display = 'none';

		const bar = append(this.root, $('.paradis-markup-toolbar'));
		bar.style.left = `${area.left + area.width / 2}px`;
		bar.style.top = `${area.top + 8}px`;
		this.status = append(bar, $('span.paradis-markup-status'));
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.setStatus(undefined);

		const tools: IToolDefinition[] = [
			{ tool: 'pen', icon: Codicon.edit, label: localize('paradis.markup.pen', "ペン") },
			{ tool: 'highlight', icon: Codicon.paintcan, label: localize('paradis.markup.highlight', "蛍光ペン") },
			{ tool: 'arrow', icon: Codicon.arrowRight, label: localize('paradis.markup.arrow', "矢印") },
			{ tool: 'rect', icon: Codicon.primitiveSquare, label: localize('paradis.markup.rect', "四角") },
			{ tool: 'ellipse', icon: Codicon.circleLarge, label: localize('paradis.markup.ellipse', "楕円") },
			{ tool: 'text', icon: Codicon.textSize, label: localize('paradis.markup.text', "文字") },
		];
		const toolGroup = append(bar, $('.paradis-markup-group'));
		for (const definition of tools) {
			const button = this.iconButton(toolGroup, definition.icon, definition.label, () => this.setTool(definition.tool));
			button.setAttribute('aria-pressed', 'false');
			this.toolButtons.set(definition.tool, button);
		}

		const colorGroup = append(bar, $('.paradis-markup-group'));
		PARADIS_MARKUP_COLORS.forEach((color, index) => {
			const button = append(colorGroup, $<HTMLButtonElement>('button.paradis-markup-swatch'));
			button.type = 'button';
			button.style.backgroundColor = color;
			const label = localize('paradis.markup.color', "色 {0}", index + 1);
			button.setAttribute('aria-label', label);
			this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, label));
			this._register(addDisposableListener(button, EventType.CLICK, () => this.setColor(color)));
			this.colorButtons.set(color, button);
		});

		const widthGroup = append(bar, $('.paradis-markup-group'));
		const widthLabels = [localize('paradis.markup.thin', "細い"), localize('paradis.markup.medium', "普通"), localize('paradis.markup.thick', "太い")];
		PARADIS_MARKUP_WIDTHS.forEach((width, index) => {
			const button = append(widthGroup, $<HTMLButtonElement>('button.paradis-markup-width'));
			button.type = 'button';
			const dot = append(button, $('span.paradis-markup-width-dot'));
			dot.style.width = `${width + 2}px`;
			dot.style.height = `${width + 2}px`;
			button.setAttribute('aria-label', widthLabels[index]);
			this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, widthLabels[index]));
			this._register(addDisposableListener(button, EventType.CLICK, () => this.setWidth(width)));
			this.widthButtons.set(width, button);
		});

		const historyGroup = append(bar, $('.paradis-markup-group'));
		this.undoButton = this.iconButton(historyGroup, Codicon.discard, localize('paradis.markup.undo', "元に戻す"), () => this.update(paradisUndoMarkup(this.doc)));
		this.redoButton = this.iconButton(historyGroup, Codicon.redo, localize('paradis.markup.redo', "やり直す"), () => this.update(paradisRedoMarkup(this.doc)));
		this.clearButton = this.iconButton(historyGroup, Codicon.trash, localize('paradis.markup.clear', "すべて消す"), () => this.update(paradisClearMarkup(this.doc)));

		const actionGroup = append(bar, $('.paradis-markup-group.paradis-markup-actions'));
		this.textButton(actionGroup, localize('paradis.markup.copy', "コピー"), false, () => void this.copy());
		this.addButton = this.textButton(actionGroup, localize('paradis.markup.add', "注釈に追加"), true, () => void this.finish(true));
		this.iconButton(actionGroup, Codicon.close, localize('paradis.markup.close', "やめる（Esc）"), () => void this.finish(false));

		this.registerCanvasListeners();
		this._register(addDisposableListener(this.root, EventType.KEY_DOWN, event => this.onKeyDown(event)));
		this._register(addDisposableListener(this.textInput, EventType.KEY_DOWN, event => this.onTextKeyDown(event)));
		this._register(addDisposableListener(this.textInput, EventType.BLUR, () => this.commitText()));
		this._register(addDisposableListener(this.image, 'load', () => this.render()));

		this.setTool('pen');
		this.setColor(this.color);
		this.setWidth(this.width);
		this.update(this.doc);
		this.root.focus();
	}

	override dispose(): void {
		if (!this.closed) {
			this.closed = true;
			this.onClose(undefined);
		}
		this.root.remove();
		getWindow(this.root).URL.revokeObjectURL(this.imageUrl);
		super.dispose();
	}

	/**
	 * 道具バーの左端に結果を出す（undefined で既定の文言に戻す）。通知のトーストは内蔵ブラウザの
	 * 裏に隠れることがあるので、書き込み中の結果はここに出す。
	 */
	private setStatus(text: string | undefined, error = false): void {
		this.status.textContent = text ?? localize('paradis.markup.status', "静止画で書き込み中");
		this.status.classList.toggle('error', error);
	}

	/** 外から閉じる（エディタのページが替わったときなど）。 */
	cancel(): void {
		void this.finish(false);
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.paradis-markup-icon'));
		button.type = 'button';
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		button.setAttribute('aria-label', label);
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, label));
		this._register(addDisposableListener(button, EventType.CLICK, () => run()));
		return button;
	}

	private textButton(parent: HTMLElement, label: string, primary: boolean, run: () => void): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.paradis-markup-text-button'));
		button.type = 'button';
		button.classList.toggle('primary', primary);
		button.textContent = label;
		this._register(addDisposableListener(button, EventType.CLICK, () => run()));
		return button;
	}

	private setTool(tool: ParadisMarkupTool): void {
		this.commitText();
		this.tool = tool;
		for (const [candidate, button] of this.toolButtons) {
			button.classList.toggle('checked', candidate === tool);
			button.setAttribute('aria-pressed', String(candidate === tool));
		}
		this.stage.classList.toggle('text-tool', tool === 'text');
	}

	private setColor(color: string): void {
		this.color = color;
		for (const [candidate, button] of this.colorButtons) {
			button.classList.toggle('checked', candidate === color);
			button.setAttribute('aria-pressed', String(candidate === color));
		}
	}

	private setWidth(width: number): void {
		this.width = width;
		for (const [candidate, button] of this.widthButtons) {
			button.classList.toggle('checked', candidate === width);
			button.setAttribute('aria-pressed', String(candidate === width));
		}
	}

	private update(doc: IParadisMarkupDocument): void {
		this.doc = doc;
		this.undoButton.disabled = doc.past.length === 0;
		this.redoButton.disabled = doc.future.length === 0;
		this.clearButton.disabled = doc.shapes.length === 0;
		this.render();
	}

	private render(): void {
		const ratio = getWindow(this.canvas).devicePixelRatio || 1;
		const width = Math.max(1, Math.round(this.area.width * ratio));
		const height = Math.max(1, Math.round(this.area.height * ratio));
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		const ctx = this.canvas.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		paradisDrawMarkupShapes(ctx, this.inProgress ? [...this.doc.shapes, this.inProgress] : this.doc.shapes);
	}

	private pointFrom(event: PointerEvent): IParadisMarkupPoint {
		const rect = this.canvas.getBoundingClientRect();
		const scaleX = rect.width > 0 ? this.area.width / rect.width : 1;
		const scaleY = rect.height > 0 ? this.area.height / rect.height : 1;
		return {
			x: Math.min(this.area.width, Math.max(0, (event.clientX - rect.left) * scaleX)),
			y: Math.min(this.area.height, Math.max(0, (event.clientY - rect.top) * scaleY)),
		};
	}

	private registerCanvasListeners(): void {
		// 押したときの既定の動作（フォーカスの移動）を止める。止めないと、文字の入力欄を出した直後に
		// フォーカスが重ね板へ移り、入力欄の blur で空のまま閉じてしまう
		this._register(addDisposableListener(this.canvas, EventType.MOUSE_DOWN, (event: MouseEvent) => event.preventDefault()));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			const point = this.pointFrom(event);
			if (this.tool === 'text') {
				this.commitText();
				this.beginText(point);
				return;
			}
			this.canvas.setPointerCapture(event.pointerId);
			const id = generateUuid();
			switch (this.tool) {
				case 'pen':
				case 'highlight':
					this.inProgress = { id, kind: this.tool, color: this.color, width: this.width, points: [point] };
					break;
				case 'arrow':
				case 'rect':
				case 'ellipse':
					this.inProgress = { id, kind: this.tool, color: this.color, width: this.width, from: point, to: point };
					break;
			}
			this.render();
		}));
		this._register(addDisposableListener(this.canvas, EventType.POINTER_MOVE, (event: PointerEvent) => {
			const shape = this.inProgress;
			if (!shape) {
				return;
			}
			const point = this.pointFrom(event);
			if (shape.kind === 'pen' || shape.kind === 'highlight') {
				const last = shape.points[shape.points.length - 1];
				if (Math.abs(last.x - point.x) + Math.abs(last.y - point.y) < 1) {
					return;
				}
				this.inProgress = { ...shape, points: [...shape.points, point] };
			} else if (shape.kind === 'arrow' || shape.kind === 'rect' || shape.kind === 'ellipse') {
				this.inProgress = { ...shape, to: point };
			}
			this.render();
		}));
		const end = (event: PointerEvent) => {
			const shape = this.inProgress;
			if (!shape) {
				return;
			}
			this.inProgress = undefined;
			if (this.canvas.hasPointerCapture(event.pointerId)) {
				this.canvas.releasePointerCapture(event.pointerId);
			}
			if (paradisIsMeaningfulMarkupShape(shape)) {
				this.update(paradisCommitMarkupShape(this.doc, shape));
			} else {
				this.render();
			}
		};
		this._register(addDisposableListener(this.canvas, EventType.POINTER_UP, end));
		this._register(addDisposableListener(this.canvas, 'pointercancel', end));
	}

	private beginText(point: IParadisMarkupPoint): void {
		this.textAt = point;
		const fontSize = paradisMarkupFontSize(this.width);
		this.textInput.value = '';
		this.textInput.style.left = `${point.x}px`;
		this.textInput.style.top = `${point.y}px`;
		this.textInput.style.fontSize = `${fontSize}px`;
		this.textInput.style.color = this.color;
		this.textInput.style.display = 'block';
		// 押した操作の後始末（フォーカスの移動）が済んでから入力欄へ移す
		const input = this.textInput;
		getWindow(input).requestAnimationFrame(() => {
			if (!this.closed && this.textAt === point) {
				input.focus();
			}
		});
	}

	private commitText(): void {
		const at = this.textAt;
		if (!at) {
			return;
		}
		this.textAt = undefined;
		const text = this.textInput.value.trim();
		this.textInput.style.display = 'none';
		this.textInput.value = '';
		if (text) {
			this.update(paradisCommitMarkupShape(this.doc, { id: generateUuid(), kind: 'text', color: this.color, at, text, fontSize: paradisMarkupFontSize(this.width) }));
		}
		if (!this.closed) {
			this.root.focus();
		}
	}

	private onTextKeyDown(event: KeyboardEvent): void {
		// 日本語入力の変換確定の Enter で確定させない
		if (event.isComposing || event.keyCode === 229) {
			event.stopPropagation();
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			this.commitText();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this.textAt = undefined;
			this.textInput.style.display = 'none';
			this.root.focus();
		} else {
			// 文字の入力中は、ワークベンチのキー割り当て（取り消しなど）へ流さない
			event.stopPropagation();
		}
	}

	private onKeyDown(browserEvent: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(browserEvent);
		const undo = event.equals(KeyMod.CtrlCmd | KeyCode.KeyZ);
		const redo = event.equals(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ) || (!isMacintosh && event.equals(KeyMod.CtrlCmd | KeyCode.KeyY));
		if (event.equals(KeyCode.Escape)) {
			event.preventDefault();
			event.stopPropagation();
			void this.finish(false);
		} else if (undo) {
			event.preventDefault();
			event.stopPropagation();
			this.update(paradisUndoMarkup(this.doc));
		} else if (redo) {
			event.preventDefault();
			event.stopPropagation();
			this.update(paradisRedoMarkup(this.doc));
		}
	}

	/** スクリーンショットに絵を焼き込んだ PNG を作る。 */
	private async compose(): Promise<Blob> {
		await this.image.decode();
		const naturalWidth = this.image.naturalWidth;
		const naturalHeight = this.image.naturalHeight;
		const canvas = getWindow(this.root).document.createElement('canvas');
		canvas.width = naturalWidth;
		canvas.height = naturalHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			throw new Error('Canvas 2D context is unavailable.');
		}
		ctx.drawImage(this.image, 0, 0);
		// 絵は CSS px で描いてあり、スクリーンショットは実ピクセル。その比で掛けて位置を合わせる
		const scale = this.area.width > 0 ? naturalWidth / this.area.width : 1;
		paradisDrawMarkupShapes(ctx, this.doc.shapes.map(shape => paradisScaleMarkupShape(shape, scale)));
		return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed.')), 'image/png'));
	}

	private async copy(): Promise<void> {
		this.commitText();
		try {
			const blob = await this.compose();
			const targetWindow = getWindow(this.root);
			await targetWindow.navigator.clipboard.write([new targetWindow.ClipboardItem({ 'image/png': blob })]);
			this.setStatus(localize('paradis.markup.copied', "書き込んだ画像をクリップボードへコピーしました"));
		} catch (error) {
			this.setStatus(localize('paradis.markup.copyFailed', "画像をコピーできませんでした: {0}", String(error)), true);
		}
	}

	private async finish(keep: boolean): Promise<void> {
		if (this.closed) {
			return;
		}
		this.commitText();
		let png: Uint8Array | undefined;
		if (keep) {
			this.addButton.disabled = true;
			try {
				png = new Uint8Array(await (await this.compose()).arrayBuffer());
			} catch (error) {
				this.addButton.disabled = false;
				const message = localize('paradis.markup.composeFailed', "画像を作れませんでした: {0}", String(error));
				this.setStatus(message, true);
				this.notificationService.notify({ severity: Severity.Error, message, sticky: true });
				return;
			}
		}
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.onClose(png);
	}
}

/** ブラウザのページが占めている矩形（ページの入れ物の親要素からの位置）。 */
export function paradisMarkupAreaOf(container: HTMLElement): IParadisMarkupArea {
	return { left: container.offsetLeft, top: container.offsetTop, width: container.offsetWidth, height: container.offsetHeight };
}
