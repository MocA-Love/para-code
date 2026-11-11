/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース」の「指示（任意）」の欄。指示の欄・サムネイル・クリップのボタンと枚数の帯を 1 つの枠にまとめる
// （Q615 の案 B）。画像は ⌘V（画像のときだけ）・枠へのドラッグ・クリップのボタンで添え、✕ で外す。

import './media/paradisWorktreeImageComposer.css';
import * as dom from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ByteSize } from '../../../../platform/files/common/files.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { IParadisWorktreeImage, PARADIS_WORKTREE_IMAGE_MAX_BYTES, PARADIS_WORKTREE_IMAGE_MAX_COUNT, paradisCheckWorktreeImages } from '../common/paradisWorktreeImageAttach.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_ATTACH = localize('paradis.worktreeImages.attach', "画像を添える");
const STR_HINT = isMacintosh
	// allow-any-unicode-next-line
	? localize('paradis.worktreeImages.hintMac', "⌘V・ドラッグで画像を添える")
	// allow-any-unicode-next-line
	: localize('paradis.worktreeImages.hint', "Ctrl+V・ドラッグで画像を添える");
// allow-any-unicode-next-line
const STR_LIMITS = localize('paradis.worktreeImages.limits', "{0} 枚・1 枚 {1} MB まで（PNG・JPEG・GIF・WebP）", PARADIS_WORKTREE_IMAGE_MAX_COUNT, PARADIS_WORKTREE_IMAGE_MAX_BYTES / ByteSize.MB);
// allow-any-unicode-next-line
const STR_DROP = localize('paradis.worktreeImages.drop', "ここに落とすと画像を添えます");
// allow-any-unicode-next-line
const STR_REMOVE = localize('paradis.worktreeImages.remove', "外す");
// allow-any-unicode-next-line
const STR_PASTED_NAME = localize('paradis.worktreeImages.pastedName', "貼り付けた画像");
// allow-any-unicode-next-line
const STR_REMOTE_NOTE = localize('paradis.worktreeImages.remoteNote', "SSH 先のスペースへ写してから、エージェントにパスで渡します");

/** 画像を添えられないときの理由。 */
export const enum ParadisWorktreeImageBlock {
	/** 添えられる。 */
	None,
	/** エージェントを実行しない。 */
	NoAgent,
	/** 選んだエージェントに画像を渡せない（Gemini CLI）。 */
	Unsupported,
}

interface IComposerImage extends IParadisWorktreeImage {
	readonly size: number;
	readonly url: string;
}

export interface IParadisWorktreeImageComposerOptions {
	/** 指示の欄の id（見出しの label の `for` が指す）。 */
	readonly inputId: string;
	readonly placeholder: string;
	/** 再表示のときに戻す画像。 */
	readonly images?: readonly IParadisWorktreeImage[];
}

/** 指示の欄と添えた画像をまとめた枠。 */
export class ParadisWorktreeImageComposer extends Disposable {

	readonly textarea: HTMLTextAreaElement;

	private readonly _frame: HTMLElement;
	private readonly _thumbs: HTMLElement;
	private readonly _clip: ParadisButton;
	private readonly _hint: HTMLElement;
	private readonly _count: HTMLElement;
	private readonly _errors: HTMLElement;
	private readonly _note: HTMLElement;
	private readonly _fileInput: HTMLInputElement;
	private readonly _thumbListeners = this._register(new DisposableStore());

	private _images: IComposerImage[] = [];
	/** 読み込み中の枚数（上限の判定に数える）。 */
	private _pending = 0;
	private _block = ParadisWorktreeImageBlock.None;
	private _blockReason = '';
	private _blockDetail: string | undefined;
	private _remote = false;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** 添えた画像が増えた・減ったとき、読み込みを始めた・終えたとき。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(parent: HTMLElement, options: IParadisWorktreeImageComposerOptions) {
		super();
		this._frame = dom.append(parent, $('.paradis-image-composer.paradis-focus-subtle-within'));
		this.textarea = dom.append(this._frame, $('textarea.pcw-prompt.paradis-image-composer-area')) as HTMLTextAreaElement;
		this.textarea.rows = 3;
		this.textarea.placeholder = options.placeholder;
		this.textarea.id = options.inputId;

		this._thumbs = dom.append(this._frame, $('.paradis-image-composer-thumbs'));
		this._thumbs.setAttribute('role', 'list');

		const bar = dom.append(this._frame, $('.paradis-image-composer-bar'));
		// アイコンは `icon` ではなく文字の中の `$(attach)` で描く。`icon` はボタンの要素そのものに codicon のクラスを付け、
		// 土台の `.paradis-button` の font-family がそれを上書きしてアイコンが四角になる（2026-11-12 に dev で確認）
		this._clip = this._register(new ParadisButton(bar, { kind: 'icon', small: true, label: `$(${Codicon.attach.id})`, ariaLabel: STR_ATTACH, title: STR_ATTACH }));
		this._clip.element.classList.add('paradis-image-composer-clip');
		this._hint = dom.append(bar, $('span.paradis-image-composer-hint'));
		dom.append(bar, $('span.paradis-image-composer-grow'));
		this._count = dom.append(bar, $('span.paradis-image-composer-count'));

		const cover = dom.append(this._frame, $('.paradis-image-composer-drop'));
		cover.setAttribute('aria-hidden', 'true');
		dom.append(cover, $('span' + ThemeIcon.asCSSSelector(Codicon.cloudUpload)));
		dom.append(cover, $('span')).textContent = STR_DROP;

		this._errors = dom.append(parent, $('.paradis-image-composer-errors'));
		this._errors.setAttribute('role', 'status');
		this._note = dom.append(parent, $('.paradis-image-composer-note'));

		this._fileInput = dom.append(parent, $('input.paradis-image-composer-file')) as HTMLInputElement;
		this._fileInput.type = 'file';
		this._fileInput.multiple = true;
		this._fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
		this._fileInput.tabIndex = -1;
		this._fileInput.setAttribute('aria-hidden', 'true');

		this._register(this._clip.onDidClick(() => {
			if (this._block === ParadisWorktreeImageBlock.None) {
				this._fileInput.click();
			}
		}));
		this._register(dom.addDisposableListener(this._fileInput, 'change', () => {
			const files = [...(this._fileInput.files ?? [])];
			// 同じファイルを続けて選んでも change が来るよう、選んだものを空にしておく
			this._fileInput.value = '';
			void this._addFiles(files);
		}));
		this._register(dom.addDisposableListener(this.textarea, 'paste', e => this._onPaste(e)));
		this._registerDrop(this._frame);

		for (const image of options.images ?? []) {
			this._images.push(this._toComposerImage(image));
		}
		this._register(toDisposable(() => {
			for (const image of this._images) {
				URL.revokeObjectURL(image.url);
			}
			this._images = [];
		}));
		this._render();
	}

	/** 添えたファイルを読み込んでいる間 true（作成を待たせる。待たせないと読み込み中の画像が黙って落ちる）。 */
	get busy(): boolean {
		return this._pending > 0;
	}

	/** 添えた画像（添えた順）。 */
	get images(): readonly IParadisWorktreeImage[] {
		return this._images.map(({ name, mime, data }) => ({ name, mime, data }));
	}

	/**
	 * 添えられるかを切り替える。添えられないときも、添えた画像は外さずに残す（選び直せば使える）。
	 * `reason` は帯に出す短い文、`detail` は画像を添えてあるときに枠の下へ出す説明。
	 */
	setBlock(block: ParadisWorktreeImageBlock, reason: string, detail?: string): void {
		this._block = block;
		this._blockReason = reason;
		this._blockDetail = detail;
		this._render();
	}

	/** スペースを SSH 先に作るか（作るなら、SSH 先へ写すことを知らせる）。 */
	setRemote(remote: boolean): void {
		this._remote = remote;
		this._render();
	}

	private _registerDrop(frame: HTMLElement): void {
		const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
		const onOver = (e: DragEvent) => {
			if (!hasFiles(e)) {
				return;
			}
			// 既定の動き（欄へパスを入れる・ワークベンチがファイルを開く）を止める
			e.preventDefault();
			e.stopPropagation();
			const allowed = this._block === ParadisWorktreeImageBlock.None;
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
			}
			frame.classList.toggle('dragging', allowed);
		};
		this._register(dom.addDisposableListener(frame, dom.EventType.DRAG_ENTER, onOver));
		this._register(dom.addDisposableListener(frame, dom.EventType.DRAG_OVER, onOver));
		this._register(dom.addDisposableListener(frame, dom.EventType.DRAG_LEAVE, e => {
			const next = e.relatedTarget;
			if (!(dom.isHTMLElement(next) && frame.contains(next))) {
				frame.classList.remove('dragging');
			}
		}));
		this._register(dom.addDisposableListener(frame, dom.EventType.DROP, e => {
			frame.classList.remove('dragging');
			if (!hasFiles(e)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (this._block === ParadisWorktreeImageBlock.None) {
				void this._addFiles([...(e.dataTransfer?.files ?? [])]);
			}
		}));
	}

	/** 画像だけを貼ったとき（文字が無く、ファイルがあるとき）に添える。文字の貼り付けは今のまま。 */
	private _onPaste(e: ClipboardEvent): void {
		const data = e.clipboardData;
		if (!data || this._block !== ParadisWorktreeImageBlock.None) {
			return;
		}
		const files = [...data.files];
		if (files.length === 0 || data.getData('text/plain').length > 0 || !files.some(file => file.type.startsWith('image/'))) {
			return;
		}
		e.preventDefault();
		void this._addFiles(files);
	}

	private async _addFiles(files: readonly File[]): Promise<void> {
		if (files.length === 0) {
			return;
		}
		const check = paradisCheckWorktreeImages(this._images.length + this._pending, files.map(file => ({ name: file.name, type: file.type, size: file.size })));
		const errors: string[] = [];
		const overCount = check.rejected.filter(rejection => rejection.reason === 'count').length;
		for (const rejection of check.rejected) {
			const file = files[rejection.index];
			const name = file.name || STR_PASTED_NAME;
			if (rejection.reason === 'size') {
				// allow-any-unicode-next-line
				errors.push(localize('paradis.worktreeImages.tooLarge', "{0} は {1} あるので添えませんでした（1 枚 {2} MB まで）", name, ByteSize.formatSize(file.size), PARADIS_WORKTREE_IMAGE_MAX_BYTES / ByteSize.MB));
			} else if (rejection.reason === 'type') {
				// allow-any-unicode-next-line
				errors.push(localize('paradis.worktreeImages.notImage', "{0} は画像ではないので添えませんでした（PNG・JPEG・GIF・WebP だけ）", name));
			}
		}
		if (overCount > 0) {
			// allow-any-unicode-next-line
			errors.push(localize('paradis.worktreeImages.tooMany', "画像は {0} 枚までです。{1} 枚は添えませんでした", PARADIS_WORKTREE_IMAGE_MAX_COUNT, overCount));
		}
		this._renderErrors(errors);
		if (check.accepted.length === 0) {
			return;
		}
		this._pending += check.accepted.length;
		this._onDidChange.fire();
		try {
			const read = await Promise.all(check.accepted.map(async ({ index, mime }) => {
				const file = files[index];
				const data = VSBuffer.wrap(new Uint8Array(await file.arrayBuffer()));
				return { name: file.name || STR_PASTED_NAME, mime, data };
			}));
			if (this._store.isDisposed) {
				return;
			}
			for (const image of read) {
				this._images.push(this._toComposerImage(image));
			}
		} catch {
			// 読めなかったファイルは添えない（消された・権限が無いなど）
		} finally {
			this._pending -= check.accepted.length;
		}
		if (!this._store.isDisposed) {
			this._render();
			this._onDidChange.fire();
		}
	}

	private _toComposerImage(image: IParadisWorktreeImage): IComposerImage {
		const url = URL.createObjectURL(new Blob([image.data.buffer.slice()], { type: image.mime }));
		return { ...image, size: image.data.byteLength, url };
	}

	private _remove(index: number): void {
		const [removed] = this._images.splice(index, 1);
		if (removed) {
			URL.revokeObjectURL(removed.url);
		}
		this._renderErrors([]);
		this._render();
		this._onDidChange.fire();
		this.textarea.focus();
	}

	private _renderErrors(errors: readonly string[]): void {
		dom.clearNode(this._errors);
		for (const error of errors) {
			const row = dom.append(this._errors, $('div'));
			dom.append(row, $('span' + ThemeIcon.asCSSSelector(Codicon.warning)));
			dom.append(row, $('span')).textContent = error;
		}
	}

	private _render(): void {
		const blocked = this._block !== ParadisWorktreeImageBlock.None;
		this._frame.classList.toggle('off', blocked);
		this._clip.enabled = !blocked;
		this._hint.textContent = blocked ? this._blockReason : STR_HINT;
		this._hint.title = blocked ? this._blockReason : STR_LIMITS;

		this._thumbListeners.clear();
		dom.clearNode(this._thumbs);
		this._thumbs.classList.toggle('hidden', this._images.length === 0);
		this._images.forEach((image, index) => {
			const thumb = dom.append(this._thumbs, $('span.paradis-image-composer-thumb'));
			thumb.setAttribute('role', 'listitem');
			thumb.title = `${image.name} (${ByteSize.formatSize(image.size)})`;
			const img = dom.append(thumb, $('img')) as HTMLImageElement;
			img.alt = image.name;
			img.src = image.url;
			const remove = dom.append(thumb, $('button.paradis-image-composer-remove.paradis-focus-ring')) as HTMLButtonElement;
			remove.type = 'button';
			remove.title = STR_REMOVE;
			// allow-any-unicode-next-line
			remove.setAttribute('aria-label', localize('paradis.worktreeImages.removeNamed', "{0} を外す", image.name));
			dom.append(remove, $('span' + ThemeIcon.asCSSSelector(Codicon.close)));
			this._thumbListeners.add(dom.addDisposableListener(remove, 'click', () => this._remove(index)));
		});

		const count = this._images.length;
		this._count.textContent = count > 0 ? `${count} / ${PARADIS_WORKTREE_IMAGE_MAX_COUNT}` : '';
		this._count.classList.toggle('full', count >= PARADIS_WORKTREE_IMAGE_MAX_COUNT);

		dom.clearNode(this._note);
		if (blocked && this._blockDetail && count > 0) {
			dom.append(this._note, $('span' + ThemeIcon.asCSSSelector(Codicon.info)));
			dom.append(this._note, $('span')).textContent = this._blockDetail;
		} else if (this._remote && !blocked && count > 0) {
			dom.append(this._note, $('span' + ThemeIcon.asCSSSelector(Codicon.remote)));
			dom.append(this._note, $('span')).textContent = STR_REMOTE_NOTE;
		}
	}
}
