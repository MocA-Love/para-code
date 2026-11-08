/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータの 1 台ぶんの映像と、人の入力（タップ・ドラッグ・キー）。
//
// 映像は shared process から 1 枚ずつ届く JPEG を Blob URL にして <img> へ差す（workbench の CSP の img-src に
// blob: がある）。<img> が描き終えたら前の Blob URL を放し、shared process へ受け取りの返事を返す
// （返事を待ってから次が来るので、renderer が追いつかないときは最新の 1 枚だけが届く）。
// 購読は {@link start} から {@link stop} まで。タブを閉じた・窓を閉じたときは dispose で購読と Blob URL を放す。
//
// 人の入力は台帳を見ない（利用者本人の操作のため）。座標は映像の矩形に対する 0〜1。

import * as dom from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisSimulatorFrameEvent, ParadisSimulatorInput } from '../common/paradisSimulator.js';
import { IParadisSimulatorSize, paradisSimulatorFitSize, paradisSimulatorHidUsage, paradisSimulatorPointFromClient, paradisSimulatorShouldSendKey } from '../common/paradisSimulatorInput.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';

const $ = dom.$;

/** Blob URL を作る・放す口（テストで差し替える）。 */
export interface IParadisSimulatorObjectUrls {
	create(blob: Blob): string;
	revoke(url: string): void;
}

const realObjectUrls: IParadisSimulatorObjectUrls = {
	create: blob => URL.createObjectURL(blob),
	revoke: url => URL.revokeObjectURL(url),
};

export class ParadisSimulatorFrameView extends Disposable {

	readonly element: HTMLElement;
	private readonly _image: HTMLImageElement;

	private readonly _subscription = this._register(new MutableDisposable());
	/** 今 <img> に差している URL と、描き終えるのを待っている URL。 */
	private _shownUrl: string | undefined;
	private _pendingUrl: string | undefined;
	private _frameSize: IParadisSimulatorSize = { width: 0, height: 0 };
	private _areaSize: IParadisSimulatorSize = { width: 0, height: 0 };

	private readonly _onDidChangeFrameSize = this._register(new Emitter<IParadisSimulatorSize>());
	/** 映像の画素数が変わった（回転・Duo の外と内の切り替え）。 */
	readonly onDidChangeFrameSize = this._onDidChangeFrameSize.event;

	private readonly _onDidFail = this._register(new Emitter<Error>());
	readonly onDidFail = this._onDidFail.event;

	private readonly _pressedKeys = new Map<string, number>();
	private _pointerId: number | undefined;
	private _pendingMove: { readonly x: number; readonly y: number } | undefined;
	private _moveScheduled = false;

	constructor(
		container: HTMLElement,
		private readonly _udid: string,
		private readonly _client: IParadisSimulatorClient,
		private readonly _urls: IParadisSimulatorObjectUrls = realObjectUrls,
	) {
		super();
		this.element = dom.append(container, $('.paradis-simulator-screen'));
		this.element.tabIndex = 0;
		this._image = dom.append(this.element, $<HTMLImageElement>('img.paradis-simulator-frame'));
		this._image.draggable = false;
		this._image.alt = '';
		this._register(dom.addDisposableListener(this._image, 'load', () => this._onImageLoaded()));
		this._register(dom.addDisposableListener(this._image, 'error', () => this._onImageLoaded()));
		this._registerPointer();
		this._registerKeys();
		this._register(toDisposable(() => this._releaseUrls()));
	}

	/** 購読しているか（テスト・診断用）。 */
	get isStreaming(): boolean {
		return !!this._subscription.value;
	}

	/** 映像の購読を始める（エディタが見えたとき）。 */
	start(): void {
		if (this._subscription.value) {
			return;
		}
		const store = new DisposableStore();
		store.add(this._client.onFrames(this._udid)(frame => this._onFrame(frame)));
		this._subscription.value = store;
	}

	/** 購読を外す（エディタが見えなくなったとき）。端末のセッションは shared process 側に残る。 */
	stop(): void {
		this._subscription.clear();
		this._releaseKeys();
	}

	/** 映像を置ける広さ（エディタの帯を除いた大きさ）。 */
	layout(area: IParadisSimulatorSize): void {
		this._areaSize = area;
		this._applySize();
	}

	focus(): void {
		this.element.focus();
	}

	private _onFrame(frame: IParadisSimulatorFrameEvent): void {
		if (this._store.isDisposed) {
			return;
		}
		const bytes = frame.jpeg.buffer;
		const url = this._urls.create(new Blob([bytes.slice()], { type: 'image/jpeg' }));
		if (this._pendingUrl) {
			// 描き終える前に次が来た（返事より先には来ないはずだが、念のため前の分を放す）
			this._urls.revoke(this._pendingUrl);
		}
		this._pendingUrl = url;
		this._image.src = url;
	}

	private _onImageLoaded(): void {
		const url = this._pendingUrl;
		if (!url || this._image.src !== url) {
			return;
		}
		this._pendingUrl = undefined;
		if (this._shownUrl) {
			this._urls.revoke(this._shownUrl);
		}
		this._shownUrl = url;
		const size = { width: this._image.naturalWidth, height: this._image.naturalHeight };
		if (size.width !== this._frameSize.width || size.height !== this._frameSize.height) {
			this._frameSize = size;
			this._applySize();
			this._onDidChangeFrameSize.fire(size);
		}
		if (this._subscription.value) {
			this._client.ackFrame(this._udid).catch(error => this._onDidFail.fire(error instanceof Error ? error : new Error(String(error))));
		}
	}

	private _releaseUrls(): void {
		for (const url of [this._pendingUrl, this._shownUrl]) {
			if (url) {
				this._urls.revoke(url);
			}
		}
		this._pendingUrl = undefined;
		this._shownUrl = undefined;
		this._image.removeAttribute('src');
	}

	private _applySize(): void {
		const fit = paradisSimulatorFitSize(this._areaSize, this._frameSize);
		this._image.style.width = `${fit.width}px`;
		this._image.style.height = `${fit.height}px`;
		// 角丸は画面の短辺の比率（Orca と同じ考え方。機種の枠そのものは後回し）
		this._image.style.borderRadius = `${Math.round(Math.min(fit.width, fit.height) * 0.09)}px`;
	}

	private _send(input: ParadisSimulatorInput): void {
		this._client.sendInput(this._udid, input).catch(error => this._onDidFail.fire(error instanceof Error ? error : new Error(String(error))));
	}

	private _point(event: PointerEvent): { readonly x: number; readonly y: number } | undefined {
		const rect = this._image.getBoundingClientRect();
		return paradisSimulatorPointFromClient(rect, event.clientX, event.clientY);
	}

	private _registerPointer(): void {
		this._register(dom.addDisposableListener(this._image, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0 || this._pointerId !== undefined || !this._shownUrl) {
				return;
			}
			const point = this._point(event);
			if (!point) {
				return;
			}
			event.preventDefault();
			this.element.focus();
			this._pointerId = event.pointerId;
			this._image.setPointerCapture?.(event.pointerId);
			this._send({ kind: 'touch', phase: 'begin', ...point });
		}));
		this._register(dom.addDisposableListener(this._image, dom.EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (event.pointerId !== this._pointerId) {
				return;
			}
			this._pendingMove = this._point(event);
			if (!this._moveScheduled) {
				// 動きは描画の 1 回に 1 度まとめて送る（ポインタの事象は描画より多く来る）
				this._moveScheduled = true;
				dom.getWindow(this._image).requestAnimationFrame(() => {
					this._moveScheduled = false;
					const move = this._pendingMove;
					this._pendingMove = undefined;
					if (move && this._pointerId !== undefined) {
						this._send({ kind: 'touch', phase: 'move', ...move });
					}
				});
			}
		}));
		const end = (event: PointerEvent) => {
			if (event.pointerId !== this._pointerId) {
				return;
			}
			this._pointerId = undefined;
			this._pendingMove = undefined;
			const point = this._point(event) ?? { x: 0.5, y: 0.5 };
			this._send({ kind: 'touch', phase: 'end', ...point });
		};
		this._register(dom.addDisposableListener(this._image, dom.EventType.POINTER_UP, end));
		this._register(dom.addDisposableListener(this._image, 'pointercancel', end));
	}

	private _registerKeys(): void {
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (!paradisSimulatorShouldSendKey(event)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const usage = paradisSimulatorHidUsage(event.code)!;
			if (!event.repeat) {
				this._pressedKeys.set(event.code, usage);
			}
			this._send({ kind: 'key', type: 'down', usage });
		}));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_UP, (event: KeyboardEvent) => {
			const usage = this._pressedKeys.get(event.code);
			if (usage === undefined) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this._pressedKeys.delete(event.code);
			this._send({ kind: 'key', type: 'up', usage });
		}));
		// フォーカスが外れたら押したままのキーを離す（Command+Tab などで keyup が来ないため）
		this._register(dom.addDisposableListener(this.element, dom.EventType.BLUR, () => this._releaseKeys()));
	}

	private _releaseKeys(): void {
		for (const usage of this._pressedKeys.values()) {
			this._send({ kind: 'key', type: 'up', usage });
		}
		this._pressedKeys.clear();
	}
}
