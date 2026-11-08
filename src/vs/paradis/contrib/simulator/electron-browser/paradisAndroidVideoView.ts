/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Android の 1 台ぶんの映像（scrcpy の H.264 を WebCodecs で復号して <canvas> に描く）と、人の入力
// （q.html Q585 の ⑥b）。
//
//  - H.264 は Annex B のまま渡す（VideoDecoder を description なしで configure すると Annex B として読む）。
//    scrcpy は SPS・PPS を config の包みで別に送るので、次の key frame の前に付けて渡す（scrcpy の client と同じ）
//  - 復号が追いつかない（待ちが {@link MAX_DECODE_QUEUE} を超えた）・壊れたときは、次の key frame まで捨て、
//    shared process に key frame を求める（P frame を飛ばすと絵が崩れるため）
//  - 購読は {@link start} から {@link stop} まで。タブを閉じた・窓を閉じたときは dispose で放す
//  - タッチは映像に対する 0〜1、キーは文字なら文字、それ以外は Android の keycode（shared process が組み立てる）

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ParadisAndroidInput, ParadisAndroidVideoWire, paradisH264CodecString } from '../common/paradisScrcpy.js';
import { IParadisSimulatorSize, paradisSimulatorFitSize, paradisSimulatorPointFromClient } from '../common/paradisSimulatorInput.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { PARADIS_SIMULATOR_DOUBLE_ESCAPE_MS, PARADIS_SIMULATOR_STALL_MS } from './paradisSimulatorFrameView.js';

const $ = dom.$;

/** 復号の待ちがこれを超えたら、次の key frame まで捨てる。 */
const MAX_DECODE_QUEUE = 8;

/** WebCodecs の VideoDecoder を作る口（テストで差し替える）。 */
export type ParadisVideoDecoderFactory = (init: VideoDecoderInit) => VideoDecoder;

const realDecoder: ParadisVideoDecoderFactory = init => new VideoDecoder(init);

export class ParadisAndroidVideoView extends Disposable {

	readonly element: HTMLElement;
	private readonly _canvas: HTMLCanvasElement;
	private readonly _subscription = this._register(new MutableDisposable());
	private _decoder: VideoDecoder | undefined;
	private _codec: string | undefined;
	private _pendingConfig: Uint8Array | undefined;
	private _waitingForKey = true;
	private _videoSize: IParadisSimulatorSize = { width: 0, height: 0 };
	private _areaSize: IParadisSimulatorSize = { width: 0, height: 0 };
	private _pointerId: number | undefined;
	private _lastEscapeAt = 0;
	private readonly _stall: RunOnceScheduler;

	private readonly _onDidDrawFrame = this._register(new Emitter<void>());
	readonly onDidDrawFrame = this._onDidDrawFrame.event;
	private readonly _onDidEnd = this._register(new Emitter<string | undefined>());
	/** 端末との通話が終わった（理由があれば添える）。 */
	readonly onDidEnd = this._onDidEnd.event;
	private readonly _onDidStall = this._register(new Emitter<void>());
	/** 購読しているのに映像が届かない。 */
	readonly onDidStall = this._onDidStall.event;
	private readonly _onDidRequestExit = this._register(new Emitter<void>());
	/** Escape を続けて 2 回押した。 */
	readonly onDidRequestExit = this._onDidRequestExit.event;
	private readonly _onDidFail = this._register(new Emitter<Error>());
	readonly onDidFail = this._onDidFail.event;

	constructor(
		container: HTMLElement,
		private readonly _serial: string,
		private readonly _client: IParadisSimulatorClient,
		private readonly _createDecoder: ParadisVideoDecoderFactory = realDecoder,
	) {
		super();
		this.element = dom.append(container, $('.paradis-simulator-screen'));
		this.element.tabIndex = 0;
		this._canvas = dom.append(this.element, $<HTMLCanvasElement>('canvas.paradis-simulator-frame'));
		// Android の端末は画面が変わらないと映像を送らないことがあるので、途切れの見張りは長めにする
		this._stall = this._register(new RunOnceScheduler(() => this._onDidStall.fire(), PARADIS_SIMULATOR_STALL_MS * 6));
		this._registerPointer();
		this._registerKeys();
		this._register(toDisposable(() => {
			this._closeDecoder();
			this.element.remove();
		}));
	}

	get isStreaming(): boolean {
		return !!this._subscription.value;
	}

	start(): void {
		if (this._subscription.value) {
			return;
		}
		const store = new DisposableStore();
		store.add(this._client.onAndroidVideo(this._serial)(message => this._onMessage(message)));
		store.add(toDisposable(() => this._stall.cancel()));
		this._subscription.value = store;
		this._waitingForKey = true;
		this._stall.schedule();
	}

	stop(): void {
		this._subscription.clear();
		this._closeDecoder();
	}

	layout(area: IParadisSimulatorSize): void {
		this._areaSize = area;
		this._applySize();
	}

	focus(): void {
		this.element.focus();
	}

	private _onMessage(message: ParadisAndroidVideoWire): void {
		if (this._store.isDisposed) {
			return;
		}
		switch (message.kind) {
			case 'size':
				this._videoSize = { width: message.width, height: message.height };
				this._canvas.width = message.width;
				this._canvas.height = message.height;
				this._applySize();
				return;
			case 'config': {
				const data = message.data.buffer.slice();
				this._pendingConfig = data;
				const codec = paradisH264CodecString(data);
				if (codec && codec !== this._codec) {
					this._codec = codec;
					this._closeDecoder();
				}
				this._waitingForKey = true;
				return;
			}
			case 'frame':
				this._stall.schedule();
				this._decode(message.data.buffer, message.key, message.pts);
				return;
			case 'ended':
				this._closeDecoder();
				this._onDidEnd.fire(message.reason);
				return;
		}
	}

	private _ensureDecoder(): VideoDecoder | undefined {
		if (this._decoder && this._decoder.state !== 'closed') {
			return this._decoder;
		}
		if (!this._codec) {
			return undefined;
		}
		const decoder = this._createDecoder({
			output: frame => {
				try {
					const context = this._canvas.getContext('2d');
					context?.drawImage(frame, 0, 0, this._canvas.width || frame.displayWidth, this._canvas.height || frame.displayHeight);
					this._onDidDrawFrame.fire();
				} finally {
					frame.close();
				}
			},
			error: error => {
				this._onDidFail.fire(error instanceof Error ? error : new Error(String(error)));
				this._closeDecoder();
				this._requestKeyFrame();
			},
		});
		// description を渡さないと Annex B として読む
		decoder.configure({ codec: this._codec, optimizeForLatency: true });
		this._decoder = decoder;
		this._waitingForKey = true;
		return decoder;
	}

	private _decode(data: Uint8Array, key: boolean, pts: number): void {
		if (this._waitingForKey && !key) {
			return;
		}
		const decoder = this._ensureDecoder();
		if (!decoder) {
			return;
		}
		if (decoder.decodeQueueSize > MAX_DECODE_QUEUE && !key) {
			// 追いつかない: 次の key frame まで捨てて求める
			this._waitingForKey = true;
			this._requestKeyFrame();
			return;
		}
		let payload = data;
		if (key && this._pendingConfig) {
			payload = new Uint8Array(this._pendingConfig.length + data.length);
			payload.set(this._pendingConfig, 0);
			payload.set(data, this._pendingConfig.length);
		}
		try {
			decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: payload }));
			this._waitingForKey = false;
		} catch (error) {
			this._onDidFail.fire(error instanceof Error ? error : new Error(String(error)));
			this._closeDecoder();
			this._requestKeyFrame();
		}
	}

	private _requestKeyFrame(): void {
		this._waitingForKey = true;
		this._client.androidResetVideo(this._serial).catch(() => undefined);
	}

	private _closeDecoder(): void {
		if (this._decoder && this._decoder.state !== 'closed') {
			try {
				this._decoder.close();
			} catch {
				// もう閉じている
			}
		}
		this._decoder = undefined;
	}

	private _applySize(): void {
		const fit = paradisSimulatorFitSize(this._areaSize, this._videoSize);
		this._canvas.style.width = `${fit.width}px`;
		this._canvas.style.height = `${fit.height}px`;
		this._canvas.style.borderRadius = `${Math.round(Math.min(fit.width, fit.height) * 0.06)}px`;
		this.element.style.width = `${fit.width}px`;
		this.element.style.height = `${fit.height}px`;
	}

	private _send(input: ParadisAndroidInput): void {
		this._client.androidInput(this._serial, input).catch(error => this._onDidFail.fire(error instanceof Error ? error : new Error(String(error))));
	}

	private _registerPointer(): void {
		const point = (event: PointerEvent) => paradisSimulatorPointFromClient(this._canvas.getBoundingClientRect(), event.clientX, event.clientY);
		this._register(dom.addDisposableListener(this._canvas, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			const at = point(event);
			if (event.button !== 0 || this._pointerId !== undefined || !at || this._videoSize.width === 0) {
				return;
			}
			event.preventDefault();
			this.element.focus();
			this._pointerId = event.pointerId;
			this._canvas.setPointerCapture?.(event.pointerId);
			this._send({ kind: 'touch', phase: 'begin', ...at });
		}));
		this._register(dom.addDisposableListener(this._canvas, dom.EventType.POINTER_MOVE, (event: PointerEvent) => {
			const at = event.pointerId === this._pointerId ? point(event) : undefined;
			if (at) {
				this._send({ kind: 'touch', phase: 'move', ...at });
			}
		}));
		const end = (event: PointerEvent) => {
			if (event.pointerId !== this._pointerId) {
				return;
			}
			this._pointerId = undefined;
			this._send({ kind: 'touch', phase: 'end', ...(point(event) ?? { x: 0.5, y: 0.5 }) });
		};
		this._register(dom.addDisposableListener(this._canvas, dom.EventType.POINTER_UP, end));
		this._register(dom.addDisposableListener(this._canvas, 'pointercancel', end));
	}

	private _registerKeys(): void {
		const onKey = (event: KeyboardEvent, down: boolean) => {
			if (event.metaKey || event.ctrlKey || event.isComposing) {
				return;
			}
			if (down && event.code === 'Escape' && !event.repeat) {
				const now = Date.now();
				if (now - this._lastEscapeAt < PARADIS_SIMULATOR_DOUBLE_ESCAPE_MS) {
					this._lastEscapeAt = 0;
					event.preventDefault();
					event.stopPropagation();
					this._onDidRequestExit.fire();
					return;
				}
				this._lastEscapeAt = now;
			}
			event.preventDefault();
			event.stopPropagation();
			this._send({ kind: 'key', down, code: event.code, key: event.key });
		};
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => onKey(event, true)));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_UP, (event: KeyboardEvent) => onKey(event, false)));
	}
}
