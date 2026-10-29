/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.tts（P9a）。Electron に無いので、OS の読み上げ（Chromium の speechSynthesis）で読む。読み上げは、拡張機能も
// ウェブのページも入らない、見えない窓（メモリだけのセッション）の中で行い、その出来事（start・word・end など）を、頼んだ文脈へ返す。
//  - 読み上げの窓は、最初に頼まれたときに作り、Para Code を終えるときに閉じる
//  - 1 つの読み上げの文は 32,768 文字まで（Chrome と同じ）
//  - 拡張機能を外す・文脈が閉じると、その拡張機能の読み上げを止める

import * as electron from 'electron';
import { randomUUID } from 'crypto';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { PARADIS_SHIM_TTS_NAMESPACE } from '../common/paradisBrowserExtensionShim.js';
import { IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';

const MAX_UTTERANCE_CHARS = 32_768;
const EVENT_PREFIX = '__paradis_tts__';

/** 読み上げの窓の中で動く関数（executeJavaScript で文字にして渡す。本体の外を参照しない）。 */
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
}

export class ParadisBrowserExtensionTts implements IDisposable {

	private _window: electron.BrowserWindow | undefined;
	private _ready: Promise<electron.BrowserWindow> | undefined;
	private readonly _pending = new Map<string, IPending>();
	private readonly _disposable: IDisposable;

	constructor(private readonly _host: ParadisExtensionApiHost) {
		this._disposable = _host.onDidCloseContext((session, extensionId, connection) => {
			if ([...this._pending.values()].some(entry => entry.session === session && entry.extensionId === extensionId && (connection === undefined || entry.connection === connection))) {
				void this._stop(entry => entry.session === session && entry.extensionId === extensionId && (connection === undefined || entry.connection === connection));
			}
		});
		const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_UTTERANCE_CHARS;
		const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
		_host.registerNamespace(PARADIS_SHIM_TTS_NAMESPACE, {
			permission: 'tts',
			methods: {
				speak: paradisDefineExtensionMethod(args => args.length === 3 && typeof args[0] === 'string' && args[0].length <= 100 && text(args[1]) && isRecord(args[2]) ? [args[0], args[1], args[2]] as [string, string, Record<string, unknown>] : undefined, (caller, requestId, utterance, options) => this._speak(caller, requestId, utterance, options)),
				stop: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => this._stop(() => true)),
				pause: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => this._run('speechSynthesis.pause()')),
				resume: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => this._run('speechSynthesis.resume()')),
				isSpeaking: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, async () => this._pending.size > 0 && await this._run('speechSynthesis.speaking') === true),
				getVoices: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, async () => {
					const voices = await this._run(`speechSynthesis.getVoices().map(voice => ({ voiceName: voice.name, lang: voice.lang, remote: !voice.localService }))`);
					return Array.isArray(voices) ? voices.map(voice => ({ ...voice, eventTypes: ['start', 'end', 'word', 'sentence', 'interrupted', 'cancelled', 'error', 'pause', 'resume'] })) : [];
				}),
			},
			events: ['onUtteranceEvent'],
		});
		electron.app?.once?.('will-quit', () => this.dispose());
	}

	dispose(): void {
		this._disposable.dispose();
		this._pending.clear();
		if (this._window && !this._window.isDestroyed()) {
			this._window.destroy();
		}
		this._window = undefined;
		this._ready = undefined;
	}

	/** 読み上げの窓（拡張機能もウェブのページも入らない、メモリだけのセッション）。 */
	private _page(): Promise<electron.BrowserWindow> {
		if (this._window && !this._window.isDestroyed() && this._ready) {
			return this._ready;
		}
		const window = new electron.BrowserWindow({ show: false, width: 1, height: 1, webPreferences: { session: electron.session.fromPartition('paradis-browser-extension-tts'), sandbox: true, backgroundThrottling: false } });
		this._window = window;
		window.webContents.on('console-message', event => {
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
		this._ready = window.loadURL('data:text/html;charset=utf-8,<!doctype html><title>Para Code text to speech</title>').then(() => window);
		return this._ready;
	}

	private async _run(expression: string): Promise<unknown> {
		const window = await this._page();
		return window.isDestroyed() ? undefined : window.webContents.executeJavaScript(expression);
	}

	private async _speak(caller: IParadisExtensionApiCaller, requestId: string, text: string, options: Record<string, unknown>): Promise<void> {
		const id = randomUUID();
		if (options.enqueue !== true) {
			// Chrome と同じく、前の読み上げを止めて知らせる
			for (const [key, entry] of this._pending) {
				this._pending.delete(key);
				this._emit(entry, 'interrupted', {});
			}
		}
		this._pending.set(id, { session: caller.session, extensionId: caller.extension.id, connection: caller.connection, requestId });
		const safe = { enqueue: options.enqueue === true, lang: options.lang, rate: options.rate, pitch: options.pitch, volume: options.volume, voiceName: options.voiceName };
		try {
			await this._run(`(${speakInPage.toString()})(${JSON.stringify(id)}, ${JSON.stringify(text)}, ${JSON.stringify(safe)}, ${JSON.stringify(EVENT_PREFIX)})`);
		} catch (error) {
			this._pending.delete(id);
			throw new ParadisExtensionApiError(error instanceof Error ? error.message : String(error));
		}
	}

	private async _stop(matches: (entry: IPending) => boolean): Promise<void> {
		let any = false;
		for (const [key, entry] of this._pending) {
			if (matches(entry)) {
				any = true;
				this._pending.delete(key);
				this._emit(entry, 'interrupted', {});
			}
		}
		if (any || this._pending.size === 0) {
			await this._run('speechSynthesis.cancel()').catch(() => undefined);
		}
	}

	private _deliver(id: string, type: string, rest: Record<string, unknown>): void {
		const entry = this._pending.get(id);
		if (!entry) {
			return;
		}
		if (type === 'end' || type === 'interrupted' || type === 'cancelled' || type === 'error') {
			this._pending.delete(id);
		}
		this._emit(entry, type, rest);
	}

	private _emit(entry: IPending, type: string, rest: Record<string, unknown>): void {
		this._host.emitToConnection(entry.session, entry.extensionId, entry.connection, PARADIS_SHIM_TTS_NAMESPACE, 'onUtteranceEvent', [entry.requestId, { type, ...rest }]);
	}
}
