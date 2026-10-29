/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisIsShellProcessName } from '../../agentChat/browser/paradisAgentChatInput.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import { PARADIS_CODEX_OVERLOAD_CONTINUE_TEXT, ParadisCodexAutoContinuePhase } from '../common/paradisCodexOverloadContinue.js';

/** shared process からの「自動で continue を送って」（`ParadisMobileAgentChat` の Codex の混み合いの続き）。 */
export interface IParadisCodexAutoContinueRequest {
	readonly t: 'action/autoContinue';
	readonly id: number;
	readonly token: string;
	readonly requestId: string;
	/** 失敗したターンが終わった時刻。これより後にペインへ打鍵があれば送らない（書きかけにつながる）。 */
	readonly since: number;
}

/**
 * 端末が自分で返す応答・報告（利用者の打鍵ではない）。フォーカスの報告、カーソル位置の応答、マウスの報告（SGR と X10）、
 * 端末の種類の応答（DA）、OSC と DCS の応答。
 */
const TERMINAL_REPORTS = /\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[?>]?[\d;]*c|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

/** 入力のうち、利用者の打鍵（または貼り付け・ほかからの送信）を含むか。端末の応答・報告だけなら false。 */
export function paradisIsTypedTerminalInput(data: string): boolean {
	return data.replace(TERMINAL_REPORTS, '').length > 0;
}

/** {@link paradisCodexComposerState} が読む画面（xterm の buffer と同じ形の一部）。 */
export interface IParadisComposerBuffer {
	readonly length: number;
	getLine(y: number): {
		readonly length: number;
		translateToString(trimRight?: boolean): string;
		getCell(x: number): { getChars(): string; isDim(): number } | undefined;
	} | undefined;
}

/** Codex の入力欄の印（U+203A）。 */
const COMPOSER_MARKER = '›';
/** 入力欄を探す、画面の下からの行数。 */
const COMPOSER_SEARCH_LINES = 40;

/** 入力欄の中の、貼り付け・画像の札（Codex が文の代わりに出す。薄く描かれても書きかけとみなす）。 */
const COMPOSER_ATTACHMENT = /\[(?:Pasted Content\b|Image #\d)/;

/**
 * Codex の入力欄が空か。下から、印 `›` が薄く（dim）ない行を入力欄の始まりとみなす。入力欄の終わりは、画面の下端の
 * 案内の行のまとまり（空行の後の、下端まで続く文字のある行）の手前。その範囲（書きかけの途中の空行も含む）の文字が
 * すべて薄い（入力欄の案内の文）なら空、薄くない文字か貼り付け・画像の札があれば書きかけ。入力欄が見つからなければ
 * 確かめられない（unknown）。
 *
 * Codex 0.165.0 の画面（偽の API サーバーで動かし、xterm で描いて確かめた。2026-10-29）: 空の入力欄は `› Ask Codex to do
 * anything` で、印は薄くなく案内の文は薄い。打った文・貼り付けの札（`[Pasted Content 1500 chars]`）・画像の札
 * （`[Image #1]`）は薄くない。会話の履歴に残った利用者の発言の行は、印のほうが薄い。入力欄の下は空行 1 行と、モデル名・
 * `? for shortcuts` の案内の行（薄くない）。書きかけの途中の空行は入力欄の中にそのまま出る。
 */
export function paradisCodexComposerState(buffer: IParadisComposerBuffer): 'empty' | 'text' | 'unknown' {
	const bottom = buffer.length - 1;
	const textOf = (y: number) => buffer.getLine(y)?.translateToString(true) ?? '';
	for (let y = bottom; y >= Math.max(0, bottom - COMPOSER_SEARCH_LINES); y--) {
		const line = buffer.getLine(y);
		if (line === undefined) {
			continue;
		}
		const text = line.translateToString(true);
		const start = text.length - text.trimStart().length;
		if (!text.trimStart().startsWith(COMPOSER_MARKER)) {
			continue;
		}
		const marker = line.getCell(start);
		if (marker === undefined || marker.isDim() !== 0) {
			continue; // 履歴の発言の行
		}
		// 入力欄の終わり: 下端の案内の行のまとまりと、その上の空行を除く（無ければ下端まで）
		let last = bottom;
		while (last > y && textOf(last).trim().length === 0) {
			last--;
		}
		let footerTop = last;
		while (footerTop > y && textOf(footerTop - 1).trim().length > 0) {
			footerTop--;
		}
		const end = footerTop > y + 1 && textOf(footerTop - 1).trim().length === 0 ? footerTop - 2 : last;
		for (let row = y; row <= end; row++) {
			const current = row === y ? line : buffer.getLine(row);
			if (current === undefined) {
				continue;
			}
			if (COMPOSER_ATTACHMENT.test(current.translateToString(true))) {
				return 'text';
			}
			for (let x = row === y ? start + 1 : 0; x < current.length; x++) {
				const cell = current.getCell(x);
				const chars = cell?.getChars() ?? '';
				if (chars.trim().length > 0 && cell!.isDim() === 0) {
					return 'text';
				}
			}
		}
		return 'empty';
	}
	return 'unknown';
}

/** 読めた中身が自動の continue の依頼か。 */
export function paradisReadCodexAutoContinueRequest(value: unknown): IParadisCodexAutoContinueRequest | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const msg = value as Record<string, unknown>;
	return msg.t === 'action/autoContinue' && typeof msg.id === 'number' && Number.isInteger(msg.id)
		&& typeof msg.token === 'string' && msg.token.length > 0 && typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 64
		&& typeof msg.since === 'number' && Number.isFinite(msg.since)
		? { t: 'action/autoContinue', id: msg.id, token: msg.token, requestId: msg.requestId, since: msg.since }
		: undefined;
}

/**
 * ウィンドウ側で、自動の continue をペインへ打つ。打つ前に、失敗の後にペインへ打鍵が無いこと、前面がシェルでないこと、
 * Codex の入力欄が空であることを確かめ、shared process に引き受けを確かめる（待つ間にユーザーが送っていたら断られる）。
 */
export class ParadisCodexAutoContinueWindow extends Disposable {
	/** ペイン（instanceId）→ 最後に利用者の入力があった時刻。 */
	private readonly lastInputAt = new Map<number, number>();

	constructor(
		terminalService: Pick<ITerminalService, 'createOnInstanceEvent' | 'onDidDisposeInstance'>,
		private readonly findInstance: (instanceId: number, token: string) => ITerminalInstance | undefined,
		private readonly report: (token: string, requestId: string, phase: ParadisCodexAutoContinuePhase) => Promise<boolean>,
		private readonly now: () => number = Date.now,
	) {
		super();
		const inputs = this._register(terminalService.createOnInstanceEvent(instance => Event.map(instance.onDidInputData, data => ({ instanceId: instance.instanceId, data }))));
		this._register(inputs.event(({ instanceId, data }) => {
			if (paradisIsTypedTerminalInput(data)) {
				this.lastInputAt.set(instanceId, this.now());
			}
		}));
		this._register(terminalService.onDidDisposeInstance(instance => this.lastInputAt.delete(instance.instanceId)));
	}

	async handle(request: IParadisCodexAutoContinueRequest): Promise<void> {
		const instance = this.findInstance(request.id, request.token);
		if (instance === undefined) {
			return; // このウィンドウのペインではない
		}
		if ((this.lastInputAt.get(instance.instanceId) ?? 0) > request.since) {
			await this.report(request.token, request.requestId, 'typed');
			return;
		}
		const check = this.checkScreen(instance);
		if (check !== undefined) {
			await this.report(request.token, request.requestId, check);
			return;
		}
		if (!(await this.report(request.token, request.requestId, 'claim'))) {
			return; // 待つ間に取りやめた
		}
		const outcome = await paradisSendAgentMessageToTui(
			PARADIS_CODEX_OVERLOAD_CONTINUE_TEXT,
			(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
			// 貼り付けの前後で、ペインが同じで前面が Codex のままか（貼った後は貼った文が入力欄にあるので、入力欄は見ない）
			async () => this.findInstance(request.id, request.token) === instance && !this.shellInForeground(instance),
		);
		if (!outcome.executed) {
			await this.report(request.token, request.requestId, 'failed');
		}
	}

	/**
	 * 打ってよい画面か。前面がシェル（Codex が外から落ちた）なら、または Codex の入力欄が空と確かめられなければ打たない
	 * （確かめられないときも打たない）。打ってよければ undefined。
	 */
	private checkScreen(instance: ITerminalInstance): 'draft' | 'unverified' | undefined {
		if (this.shellInForeground(instance)) {
			return 'unverified';
		}
		const buffer = instance.xterm?.raw.buffer.active;
		const state = buffer !== undefined ? paradisCodexComposerState(buffer) : 'unknown';
		return state === 'unknown' ? 'unverified' : state === 'text' ? 'draft' : undefined;
	}

	/** 前面のプロセス（pty host が知らせる名前）がシェルか。名前が分からなければ入力欄の確かめに任せる。 */
	private shellInForeground(instance: ITerminalInstance): boolean {
		const processName = instance.processName.trim();
		return processName.length > 0 && paradisIsShellProcessName(processName);
	}
}
