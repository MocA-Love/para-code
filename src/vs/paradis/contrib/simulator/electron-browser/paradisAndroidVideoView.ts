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
import { localize } from '../../../../nls.js';
import { ParadisAndroidInput, ParadisAndroidVideoWire, paradisH264CodecString } from '../common/paradisScrcpy.js';
import { IParadisSimulatorSize, paradisSimulatorFitSize, paradisSimulatorPointFromClient } from '../common/paradisSimulatorInput.js';
import { IParadisSimulatorClient } from './paradisSimulatorClient.js';
import { PARADIS_SIMULATOR_DOUBLE_ESCAPE_MS, PARADIS_SIMULATOR_STALL_MS } from './paradisSimulatorFrameView.js';

const $ = dom.$;

/** 復号の待ちがこれを超えたら、次の key frame まで捨てる。 */
const MAX_DECODE_QUEUE = 8;

/** 続けてこの回数だけ（1 枚も描けないまま）復号に失敗したら、やめて知らせる（失敗と key frame の求めを繰り返さない）。 */
const MAX_DECODE_FAILURES = 3;

/** WebCodecs の VideoDecoder を作る口と、その設定で復号できるかを確かめる口（テストで差し替える）。 */
export interface IParadisVideoDecoders {
	create(init: VideoDecoderInit): VideoDecoder;
	isSupported(config: VideoDecoderConfig): Promise<boolean>;
}

const realDecoders: IParadisVideoDecoders = {
	create: init => new VideoDecoder(init),
	isSupported: async config => (await VideoDecoder.isConfigSupported(config)).supported === true,
};

export class ParadisAndroidVideoView extends Disposable {

	readonly element: HTMLElement;
	private readonly _canvas: HTMLCanvasElement;
	/** 描く先の文脈（canvas は替えないので、同じものを毎フレーム使う）。 */
	private readonly _context: CanvasRenderingContext2D | null;
	private readonly _subscription = this._register(new MutableDisposable());
	private _decoder: VideoDecoder | undefined;
	private _codec: string | undefined;
	private _pendingConfig: Uint8Array | undefined;
	private _waitingForKey = true;
	private _videoSize: IParadisSimulatorSize = { width: 0, height: 0 };
	private _areaSize: IParadisSimulatorSize = { width: 0, height: 0 };
	private _pointerId: number | undefined;
	/** 押したまま離していないキー（code → key）。フォーカスが外れたときなどに離す。 */
	private readonly _pressedKeys = new Map<string, string>();
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
	private readonly _onDidGiveUp = this._register(new Emitter<string>());
	/** 復号できない（この codec を扱えない・続けて失敗した）ので映すのをやめた。理由を添える。 */
	readonly onDidGiveUp = this._onDidGiveUp.event;
	private _failures = 0;
	/** 確かめ終えた codec と、その答え。 */
	private _supported: { readonly codec: string; readonly supported: Promise<boolean> } | undefined;
	private _gaveUp = false;

	constructor(
		container: HTMLElement,
		private readonly _serial: string,
		private readonly _client: IParadisSimulatorClient,
		private readonly _decoders: IParadisVideoDecoders = realDecoders,
	) {
		super();
		this.element = dom.append(container, $('.paradis-simulator-screen'));
		this.element.tabIndex = 0;
		this._canvas = dom.append(this.element, $<HTMLCanvasElement>('canvas.paradis-simulator-frame'));
		this._context = this._canvas.getContext('2d');
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
		this._failures = 0;
		this._gaveUp = false;
		this._stall.schedule();
	}

	/** 復号器が開いているか（テスト用）。 */
	get decoderOpen(): boolean {
		return !!this._decoder && this._decoder.state !== 'closed';
	}

	stop(): void {
		this._subscription.clear();
		this._closeDecoder();
		this._releaseKeys();
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
				void this._decode(message.data.buffer, message.key, message.pts);
				return;
			case 'ended':
				this._closeDecoder();
				this._onDidEnd.fire(message.reason);
				return;
		}
	}

	/** その codec を復号できるか（codec ごとに 1 回だけ確かめる）。 */
	private _isSupported(codec: string): Promise<boolean> {
		if (this._supported?.codec !== codec) {
			this._supported = { codec, supported: this._decoders.isSupported({ codec, optimizeForLatency: true }).catch(() => false) };
		}
		return this._supported.supported;
	}

	private _ensureDecoder(): VideoDecoder | undefined {
		if (this._decoder && this._decoder.state !== 'closed') {
			return this._decoder;
		}
		if (!this._codec) {
			return undefined;
		}
		const decoder = this._decoders.create({
			output: frame => {
				try {
					this._context?.drawImage(frame, 0, 0, this._canvas.width || frame.displayWidth, this._canvas.height || frame.displayHeight);
					this._failures = 0;
					// 途切れの見張りは、届いたときではなく描けたときに延ばす（届いても描けなければ途切れとみなす）
					this._stall.schedule();
					this._onDidDrawFrame.fire();
				} finally {
					frame.close();
				}
			},
			error: error => this._onDecodeError(error),
		});
		// description を渡さないと Annex B として読む
		decoder.configure({ codec: this._codec, optimizeForLatency: true });
		this._decoder = decoder;
		this._waitingForKey = true;
		return decoder;
	}

	private _onDecodeError(error: unknown): void {
		this._onDidFail.fire(error instanceof Error ? error : new Error(String(error)));
		this._closeDecoder();
		this._failures++;
		if (this._failures >= MAX_DECODE_FAILURES) {
			this._giveUp(error instanceof Error ? error.message : String(error));
			return;
		}
		this._requestKeyFrame();
	}

	private _giveUp(reason: string): void {
		if (this._gaveUp) {
			return;
		}
		this._gaveUp = true;
		this.stop();
		this._onDidGiveUp.fire(reason);
	}

	private async _decode(data: Uint8Array, key: boolean, pts: number): Promise<void> {
		if (this._gaveUp || (this._waitingForKey && !key)) {
			return;
		}
		if (!this._decoder && this._codec && !await this._isSupported(this._codec)) {
			this._giveUp(localize('paradis.android.codecUnsupported', "このウィンドウでは {0} の映像を復号できません（WebCodecs）。", this._codec));
			return;
		}
		if (this._gaveUp || !this._subscription.value) {
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
			this._onDecodeError(error);
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
					this._releaseKeys();
					this._onDidRequestExit.fire();
					return;
				}
				this._lastEscapeAt = now;
			}
			event.preventDefault();
			event.stopPropagation();
			if (down) {
				this._pressedKeys.set(event.code, event.key);
			} else {
				this._pressedKeys.delete(event.code);
			}
			this._send({ kind: 'key', down, code: event.code, key: event.key });
		};
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => onKey(event, true)));
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_UP, (event: KeyboardEvent) => onKey(event, false)));
		// フォーカスが外れたら押したままのキーを離す（Command+Tab などで keyup が来ないため。iOS の枠と同じ）
		this._register(dom.addDisposableListener(this.element, dom.EventType.BLUR, () => this._releaseKeys()));
	}

	private _releaseKeys(): void {
		for (const [code, key] of this._pressedKeys) {
			this._send({ kind: 'key', down: false, code, key });
		}
		this._pressedKeys.clear();
	}
}
