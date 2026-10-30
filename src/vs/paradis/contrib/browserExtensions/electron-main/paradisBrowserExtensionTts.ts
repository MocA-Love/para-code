/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.tts（P9a）。Electron に無いので、OS の読み上げ（Chromium の speechSynthesis）で読む。読み上げは、拡張機能も
// ウェブのページも入らない、どの窓にも付けない WebContentsView（メモリだけのセッション）の中で行い、その出来事（start・word・end
// など）を、頼んだ文脈へ返す。
//  - 窓（BrowserWindow）にしない: 見えない窓が残ると、Windows・Linux で最後の窓を閉じても window-all-closed が来ず、Para Code が終わらない
//  - 読み上げの面は、最初に頼まれたときに作り、待っている読み上げが無くなって少し経ったら閉じる（次に頼まれたら作り直す）。
//    Para Code を終えるとき（onWillShutdown）にも閉じる。描く側が落ちたら、待っている読み上げを error で終わらせて作り直す
//  - 1 つの読み上げの文は 32,768 文字まで（Chrome と同じ）
//  - 拡張機能を外す・文脈が閉じると、その拡張機能の読み上げを止める

import * as electron from 'electron';
import { randomUUID } from 'crypto';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { PARADIS_SHIM_TTS_NAMESPACE } from '../common/paradisBrowserExtensionShim.js';
import { IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';

const MAX_UTTERANCE_CHARS = 32_768;
const EVENT_PREFIX = '__paradis_tts__';

/** 読み上げの面の中で動く関数（executeJavaScript で文字にして渡す。本体の外を参照しない）。 */
function speakInPage(id: string, text: string, options: Record<string, unknown>, prefix: string): void {
	const synth = globalThis.speechSynthesis;
	const report = (type: string, extra: Record<string, unknown> = {}) => console.log(prefix + JSON.stringify({ id, type, ...extra }));
	if (!synth) {
		report('error', { errorMessage: 'Speech synthesis is not available' });
		return;
	}
	if (options.enqueue !== true) {
		synth.cancel();
	}
	const utterance = new SpeechSynthesisUtterance(text);
	if (typeof options.lang === 'string') {
		utterance.lang = options.lang;
	}
	if (typeof options.rate === 'number') {
		utterance.rate = options.rate;
	}
	if (typeof options.pitch === 'number') {
		utterance.pitch = options.pitch;
	}
	if (typeof options.volume === 'number') {
		utterance.volume = options.volume;
	}
	if (typeof options.voiceName === 'string') {
		const voice = synth.getVoices().find(candidate => candidate.name === options.voiceName);
		if (voice) {
			utterance.voice = voice;
		}
	}
	utterance.onstart = () => report('start', { charIndex: 0 });
	utterance.onend = () => report('end', { charIndex: text.length });
	utterance.onerror = event => report(event.error === 'interrupted' || event.error === 'canceled' ? 'interrupted' : 'error', { errorMessage: event.error });
	utterance.onboundary = event => report(event.name === 'sentence' ? 'sentence' : 'word', { charIndex: event.charIndex, length: event.charLength });
	utterance.onpause = () => report('pause');
	utterance.onresume = () => report('resume');
	synth.speak(utterance);
}

interface IPending {
	readonly session: ParadisApiSession;
	readonly extensionId: string;
	readonly connection: string;
	readonly requestId: string;
	readonly text: string;
	readonly options: Record<string, unknown>;
	/** 拡張機能へ start を送った（読み直したときに、2 回目の start を送らない）。 */
	started?: boolean;
}

/** 順番待ちの 1 回（speak・stop）の期限。過ぎたら面を閉じて作り直す。 */
const OPERATION_TIMEOUT_MS = 10_000;

/** 待っている読み上げが無くなってから、読み上げの面を閉じるまで。 */
const IDLE_CLOSE_MS = 30_000;

export class ParadisBrowserExtensionTts implements IDisposable {

	private _view: electron.WebContentsView | undefined;
	private _ready: Promise<electron.WebContents> | undefined;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** 読み上げの id → 頼んだ文脈（頼んだ順）。 */
	private readonly _pending = new Map<string, IPending>();
	private readonly _disposable: IDisposable;
	/** 読み上げの待ち行列を変える処理（speak・stop）を 1 つずつ順に走らせる（読み直しの途中に割り込ませない）。 */
	private _queue: Promise<unknown> = Promise.resolve();
	/** 閉じた後（Para Code を終えるところ）は、順番待ちの読み上げが面を作り直さない。 */
	private _disposed = false;

	constructor(private readonly _host: ParadisExtensionApiHost) {
		this._disposable = _host.onDidCloseContext((session, extensionId, connection) => {
			void this._stop(entry => entry.session === session && entry.extensionId === extensionId && (connection === undefined || entry.connection === connection));
		});
		const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_UTTERANCE_CHARS;
		const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
		_host.registerNamespace(PARADIS_SHIM_TTS_NAMESPACE, {
			permission: 'tts',
			methods: {
				speak: paradisDefineExtensionMethod(args => args.length === 3 && typeof args[0] === 'string' && args[0].length <= 100 && text(args[1]) && isRecord(args[2]) ? [args[0], args[1], args[2]] as [string, string, Record<string, unknown>] : undefined, (caller, requestId, utterance, options) => this._speak(caller, requestId, utterance, options)),
				// 止めるのは、呼び出した拡張機能の読み上げだけ（ほかの拡張機能の読み上げは続ける）
				stop: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => this._stop(entry => entry.session === caller.session && entry.extensionId === caller.extension.id)),
				pause: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => this._run('speechSynthesis.pause()', false)),
				resume: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => this._run('speechSynthesis.resume()', false)),
				isSpeaking: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, async () => this._pending.size > 0 && await this._run('speechSynthesis.speaking', false) === true),
				getVoices: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, async () => {
					const voices = await this._run(`speechSynthesis.getVoices().map(voice => ({ voiceName: voice.name, lang: voice.lang, remote: !voice.localService }))`, true);
					this._scheduleIdleClose();
					return Array.isArray(voices) ? voices.map(voice => ({ ...voice, eventTypes: ['start', 'end', 'word', 'sentence', 'interrupted', 'cancelled', 'error', 'pause', 'resume'] })) : [];
				}),
			},
			events: ['onUtteranceEvent'],
		});
	}

	/** Para Code を終えるとき・拡張機能の管理を閉じるとき: 読み上げの面を閉じる。 */
	dispose(): void {
		this._disposed = true;
		this._disposable.dispose();
		this._pending.clear();
		this._close();
	}

	/** 読み上げの面を閉じる（待っている読み上げは呼び出した側が片付ける）。 */
	private _close(): void {
		clearTimeout(this._idleTimer);
		this._idleTimer = undefined;
		const view = this._view;
		this._view = undefined;
		this._ready = undefined;
		if (view && !view.webContents.isDestroyed()) {
			view.webContents.close();
		}
	}

	private _scheduleIdleClose(): void {
		clearTimeout(this._idleTimer);
		this._idleTimer = undefined;
		if (this._pending.size === 0 && this._view) {
			this._idleTimer = setTimeout(() => {
				if (this._pending.size === 0) {
					this._close();
				}
			}, IDLE_CLOSE_MS);
			(this._idleTimer as { unref?(): void }).unref?.();
		}
	}

	/** 読み上げの面（拡張機能もウェブのページも入らない、メモリだけのセッション。どの窓にも付けない）。 */
	private _page(): Promise<electron.WebContents> {
		if (this._disposed) {
			return Promise.reject(new Error('Para Code is quitting'));
		}
		if (this._view && !this._view.webContents.isDestroyed() && this._ready) {
			return this._ready;
		}
		const view = new electron.WebContentsView({ webPreferences: { session: electron.session.fromPartition('paradis-browser-extension-tts'), sandbox: true, backgroundThrottling: false } });
		this._view = view;
		const contents = view.webContents;
		contents.on('console-message', event => {
			const message = String((event as unknown as { message?: unknown }).message ?? '');
			if (!message.startsWith(EVENT_PREFIX)) {
				return;
			}
			try {
				const { id, type, ...rest } = JSON.parse(message.slice(EVENT_PREFIX.length)) as { id: string; type: string; charIndex?: number; length?: number; errorMessage?: string };
				this._deliver(id, type, rest);
			} catch {
				// 読めない知らせは捨てる
			}
		});
		contents.on('render-process-gone', () => {
			// 描く側が落ちた: 待っている読み上げを終わらせ、次に頼まれたら作り直す
			if (this._view === view) {
				for (const [id, entry] of [...this._pending]) {
					this._pending.delete(id);
					this._emit(entry, 'error', { errorMessage: 'The speech engine stopped' });
				}
				this._close();
			}
		});
		this._ready = contents.loadURL('data:text/html;charset=utf-8,<!doctype html><title>Para Code text to speech</title>').then(() => contents);
		return this._ready;
	}

	/** 面の中で式を動かす。`create` が false なら、面が無いときは作らずに undefined。 */
	private async _run(expression: string, create: boolean): Promise<unknown> {
		if (!create && !this._view) {
			return undefined;
		}
		const contents = await this._page();
		return contents.isDestroyed() ? undefined : contents.executeJavaScript(expression);
	}

	private async _say(id: string, entry: Pick<IPending, 'text' | 'options'>, enqueue: boolean): Promise<void> {
		const safe = { enqueue, lang: entry.options.lang, rate: entry.options.rate, pitch: entry.options.pitch, volume: entry.options.volume, voiceName: entry.options.voiceName };
		await this._run(`(${speakInPage.toString()})(${JSON.stringify(id)}, ${JSON.stringify(entry.text)}, ${JSON.stringify(safe)}, ${JSON.stringify(EVENT_PREFIX)})`, true);
	}

	private _serialized<T>(run: () => Promise<T>): Promise<T> {
		// 1 回ごとに期限を付ける。面が答えなくなったら（描く側が固まったなど）、閉じて作り直し、後ろの順番待ちを止めない
		const limited = (): Promise<T> => new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				for (const [id, entry] of [...this._pending]) {
					this._pending.delete(id);
					this._emit(entry, 'error', { errorMessage: 'The speech engine did not answer' });
				}
				this._close();
				reject(new ParadisExtensionApiError('The speech engine did not answer'));
			}, OPERATION_TIMEOUT_MS);
			run().then(value => {
				clearTimeout(timer);
				resolve(value);
			}, error => {
				clearTimeout(timer);
				reject(error);
			});
		});
		const next = this._queue.then(limited, limited);
		this._queue = next.catch(() => undefined);
		return next;
	}

	private _speak(caller: IParadisExtensionApiCaller, requestId: string, text: string, options: Record<string, unknown>): Promise<void> {
		return this._serialized(() => this._doSpeak(caller, requestId, text, options));
	}

	private _stop(matches: (entry: IPending) => boolean): Promise<void> {
		return this._serialized(() => this._doStop(matches));
	}

	private async _doSpeak(caller: IParadisExtensionApiCaller, requestId: string, text: string, options: Record<string, unknown>): Promise<void> {
		clearTimeout(this._idleTimer);
		const id = randomUUID();
		const enqueue = options.enqueue === true;
		if (!enqueue) {
			// Chrome と同じく、前の読み上げを止めて知らせる
			for (const [key, entry] of [...this._pending]) {
				this._pending.delete(key);
				this._emit(entry, 'interrupted', {});
			}
		}
		this._pending.set(id, { session: caller.session, extensionId: caller.extension.id, connection: caller.connection, requestId, text, options });
		try {
			await this._say(id, { text, options }, enqueue);
		} catch (error) {
			this._pending.delete(id);
			this._scheduleIdleClose();
			throw new ParadisExtensionApiError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * 当てはまる読み上げを止める。speechSynthesis は待ち行列の一部だけを外せないので、全部を止めてから、
	 * 当てはまらない残り（ほかの拡張機能の読み上げ）を同じ順で読み直す（今読んでいたものは頭から読み直しになる）。
	 */
	private async _doStop(matches: (entry: IPending) => boolean): Promise<void> {
		const stopped = [...this._pending].filter(([, entry]) => matches(entry));
		if (stopped.length === 0) {
			return;
		}
		for (const [id, entry] of stopped) {
			this._pending.delete(id);
			this._emit(entry, 'interrupted', {});
		}
		const rest = [...this._pending.values()];
		this._pending.clear();
		await this._run('speechSynthesis.cancel()', false).catch(() => undefined);
		for (const entry of rest) {
			const id = randomUUID();
			this._pending.set(id, entry);
			await this._say(id, entry, true).catch(() => this._pending.delete(id));
		}
		this._scheduleIdleClose();
	}

	private _deliver(id: string, type: string, rest: Record<string, unknown>): void {
		const entry = this._pending.get(id);
		if (!entry) {
			return;
		}
		if (type === 'start') {
			if (entry.started) {
				// 読み直した読み上げ: 拡張機能には最初の読み上げのときに start を送ってある
				return;
			}
			entry.started = true;
		}
		if (type === 'end' || type === 'interrupted' || type === 'cancelled' || type === 'error') {
			this._pending.delete(id);
			this._scheduleIdleClose();
		}
		this._emit(entry, type, rest);
	}

	private _emit(entry: IPending, type: string, rest: Record<string, unknown>): void {
		this._host.emitToConnection(entry.session, entry.extensionId, entry.connection, PARADIS_SHIM_TTS_NAMESPACE, 'onUtteranceEvent', [entry.requestId, { type, ...rest }]);
	}
}
