/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示の入力欄。日本語入力（変換中の Enter で送らない）、下書きの保持、送信履歴、
// スラッシュコマンドの補完を持つ。送った文はターミナルの TUI へ貼り付けて Enter を送る
// （送り方は呼び出し側 = host が持つ）。

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IParadisAgentChatCommand } from '../common/paradisAgentChat.js';
import { paradisDuplicateAgentChatCommandNames, paradisFilterAgentChatCommands, paradisAgentChatSlashQuery } from '../common/paradisAgentChatComposerLogic.js';

/** 送信のキー。Q32: 既定は Enter で送信・Shift+Enter で改行。設定で ⌘Enter 送信に変えられる。 */
export type ParadisAgentChatSendKey = 'enter' | 'modEnter';

/** 入力欄が呼び出し側へ求めるもの。 */
export interface IParadisAgentChatComposerHost {
	getSendKey(): ParadisAgentChatSendKey;
	getDraft(token: string): string;
	setDraft(token: string, text: string): void;
	getHistory(token: string): readonly string[];
	getCommands(token: string): Promise<readonly IParadisAgentChatCommand[]>;
}

/** 送信履歴の上限（ペインごと）。 */
export const PARADIS_AGENT_CHAT_HISTORY_LIMIT = 50;
/** 補完の候補を一度に出す数。 */
const SLASH_MENU_LIMIT = 12;
/** 変換の確定直後に届く Enter を送信と取り違えないための猶予。 */
const COMPOSITION_END_GRACE_MS = 50;

export class ParadisAgentChatComposer extends Disposable {

	private readonly _onDidSubmit = this._register(new Emitter<string>());
	/** 送信が押された（空白だけの文は来ない）。 */
	readonly onDidSubmit: Event<string> = this._onDidSubmit.event;

	readonly element: HTMLElement;
	private readonly textarea: HTMLTextAreaElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly hint: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly slashMenu: HTMLElement;

	private token: string | undefined;
	private composing = false;
	private compositionEndedAt = 0;
	/** 履歴をたどっている位置（-1 = 下書きを編集中）。 */
	private historyIndex = -1;
	/** 履歴をたどり始める前の下書き。 */
	private historyDraft = '';
	private blockedReason: string | undefined;
	private busy = false;
	/** 送っている最中（貼り付けと Enter の間に数百 ms かかる）。二重送信を防ぐ。 */
	private sending = false;
	private slashItems: readonly IParadisAgentChatCommand[] = [];
	/** 一覧の中で 2 件以上ある名前（小文字）。この名前の候補には出どころを添える（上にある方が実際に動く）。 */
	private slashDuplicates: ReadonlySet<string> = new Set();
	private readonly slashRowListeners = this._register(new DisposableStore());
	private slashSelected = 0;
	private slashRequest = 0;

	constructor(parent: HTMLElement, private readonly host: IParadisAgentChatComposerHost) {
		super();
		this.element = append(parent, $('.paradis-agent-chat-composer'));
		this.slashMenu = append(this.element, $('.paradis-agent-chat-slash-menu'));
		this.slashMenu.setAttribute('role', 'listbox');
		this.slashMenu.style.display = 'none';
		this.notice = append(this.element, $('.paradis-agent-chat-composer-notice'));
		this.notice.setAttribute('aria-live', 'polite');
		const box = append(this.element, $('.paradis-agent-chat-composer-box'));
		this.textarea = append(box, $('textarea.paradis-agent-chat-input')) as HTMLTextAreaElement;
		this.textarea.rows = 1;
		this.textarea.spellcheck = false;
		this.textarea.setAttribute('aria-label', localize('paradisAgentChat.inputAria', "エージェントへのメッセージ"));
		const footer = append(box, $('.paradis-agent-chat-composer-footer'));
		this.hint = append(footer, $('span.paradis-agent-chat-composer-hint'));
		this.sendButton = append(footer, $('button.paradis-agent-chat-send')) as HTMLButtonElement;
		this.sendButton.type = 'button';
		this.sendButton.textContent = localize('paradisAgentChat.send', "送信");

		this._register(addDisposableListener(this.textarea, 'compositionstart', () => { this.composing = true; }));
		this._register(addDisposableListener(this.textarea, 'compositionend', () => {
			this.composing = false;
			this.compositionEndedAt = Date.now();
		}));
		this._register(addDisposableListener(this.textarea, EventType.INPUT, () => this.onInput()));
		this._register(addDisposableListener(this.textarea, EventType.KEY_DOWN, e => this.onKeyDown(e)));
		const blurTimer = this._register(new MutableDisposable());
		this._register(addDisposableListener(this.textarea, EventType.BLUR, () => {
			// メニューのクリックより先に blur が来るので、少し待ってから閉じる。
			blurTimer.value = disposableTimeout(() => this.hideSlashMenu(), 150);
		}));
		this._register(addDisposableListener(this.sendButton, EventType.CLICK, () => this.submit()));
		this.updateHint();
		this.updateSendState();
	}

	/** 対象のペインを差し替える。下書きはペインごとに保つ。 */
	setToken(token: string | undefined): void {
		if (this.token === token) {
			return;
		}
		if (this.token !== undefined) {
			this.host.setDraft(this.token, this.textarea.value);
		}
		this.token = token;
		this.historyIndex = -1;
		this.sending = false;
		this.textarea.value = token !== undefined ? this.host.getDraft(token) : '';
		this.hideSlashMenu();
		this.autosize();
		this.updateSendState();
	}

	/** 送れない理由（質問・承認の回答待ちなど）。undefined なら送れる。 */
	setBlockedReason(reason: string | undefined): void {
		if (this.blockedReason === reason) {
			return;
		}
		this.blockedReason = reason;
		this.showNotice(reason);
		this.updateSendState();
	}

	/** 送っている最中は送信を受け付けない。 */
	setSending(sending: boolean): void {
		this.sending = sending;
		this.updateSendState();
	}

	/** エージェントが動いている間は、送った文が TUI の待ち行列に入る旨を見せる。 */
	setBusy(busy: boolean): void {
		if (this.busy !== busy) {
			this.busy = busy;
			this.updateHint();
		}
	}

	/** 送れなかった理由の表示を消し、送れない理由（あれば）の表示へ戻す。 */
	clearError(): void {
		this.showNotice(this.blockedReason);
	}

	showNotice(message: string | undefined): void {
		this.notice.textContent = message ?? '';
		this.notice.classList.toggle('visible', message !== undefined && message.length > 0);
	}

	/** 入力欄のカーソル位置へ文字を差し込む（ファイルのドロップなど）。 */
	insertText(text: string): void {
		const start = this.textarea.selectionStart;
		const end = this.textarea.selectionEnd;
		this.textarea.setRangeText(text, start, end, 'end');
		this.onInput();
		this.textarea.focus();
	}

	focus(): void {
		this.textarea.focus();
		const end = this.textarea.value.length;
		this.textarea.setSelectionRange(end, end);
	}

	hasFocus(): boolean {
		return this.textarea.ownerDocument.activeElement === this.textarea;
	}

	/**
	 * 送った文を入力欄から消す（送れなかったときは呼ばない＝文が残る）。送っている間に打ち足していたら
	 * 消さない（打ち足した分まで消えるため）。
	 */
	clearAfterSend(sentText: string): void {
		if (this.textarea.value !== sentText) {
			return;
		}
		this.textarea.value = '';
		this.historyIndex = -1;
		if (this.token !== undefined) {
			this.host.setDraft(this.token, '');
		}
		this.autosize();
		this.updateSendState();
	}

	/** 変更された設定（送信のキー）を表示へ反映する。 */
	refreshSettings(): void {
		this.updateHint();
	}

	private updateHint(): void {
		const modifier = isMacintosh ? '⌘' : 'Ctrl+';
		const text = this.host.getSendKey() === 'modEnter'
			? localize('paradisAgentChat.hintModEnter', "{0}Enter で送信 · Enter で改行", modifier)
			: localize('paradisAgentChat.hintEnter', "Enter で送信 · Shift+Enter で改行");
		this.hint.textContent = this.busy ? localize('paradisAgentChat.hintBusy', "{0} · 作業中に送ると、終わってから読まれます", text) : text;
	}

	private updateSendState(): void {
		const empty = this.textarea.value.trim().length === 0;
		this.sendButton.disabled = empty || this.blockedReason !== undefined || this.sending;
	}

	private onInput(): void {
		this.historyIndex = -1;
		if (this.token !== undefined) {
			this.host.setDraft(this.token, this.textarea.value);
		}
		this.autosize();
		this.updateSendState();
		this.updateSlashMenu();
	}

	private autosize(): void {
		this.textarea.style.height = 'auto';
		this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 240)}px`;
	}

	private isComposingKey(e: KeyboardEvent): boolean {
		// 変換中の Enter（確定）は送信に使わない。keyCode 229 は変換中の打鍵を表す。
		return this.composing || e.isComposing || e.keyCode === 229 || Date.now() - this.compositionEndedAt < COMPOSITION_END_GRACE_MS;
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (this.isComposingKey(e)) {
			return;
		}
		const event = new StandardKeyboardEvent(e);
		const slashOpen = this.slashMenu.style.display !== 'none' && this.slashItems.length > 0;
		if (slashOpen) {
			if (event.keyCode === KeyCode.DownArrow || event.keyCode === KeyCode.UpArrow) {
				this.moveSlashSelection(event.keyCode === KeyCode.DownArrow ? 1 : -1);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if ((event.keyCode === KeyCode.Tab || event.keyCode === KeyCode.Enter) && !event.shiftKey && !event.altKey) {
				this.acceptSlash(this.slashSelected);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.keyCode === KeyCode.Escape) {
				this.hideSlashMenu();
				event.preventDefault();
				event.stopPropagation();
				return;
			}
		}
		if (event.keyCode === KeyCode.Enter) {
			const modEnter = this.host.getSendKey() === 'modEnter';
			const wantsSend = modEnter ? (event.ctrlKey || event.metaKey) : (!event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey);
			if (wantsSend) {
				event.preventDefault();
				event.stopPropagation();
				// 押しっぱなしのキーリピートで同じ文を何度も送らない。
				if (!e.repeat) {
					this.submit();
				}
				return;
			}
			if (!modEnter && event.shiftKey) {
				// 既定の改行に任せる（ワークベンチのキー割り当てへ渡さない）。
				event.stopPropagation();
			}
			return;
		}
		if (event.keyCode === KeyCode.UpArrow && !event.shiftKey && this.caretOnFirstLine()) {
			if (this.recallHistory(1)) {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (event.keyCode === KeyCode.DownArrow && !event.shiftKey && this.historyIndex >= 0 && this.caretOnLastLine()) {
			if (this.recallHistory(-1)) {
				event.preventDefault();
				event.stopPropagation();
			}
		}
	}

	private caretOnFirstLine(): boolean {
		return this.textarea.selectionStart === this.textarea.selectionEnd && !this.textarea.value.slice(0, this.textarea.selectionStart).includes('\n');
	}

	private caretOnLastLine(): boolean {
		return this.textarea.selectionStart === this.textarea.selectionEnd && !this.textarea.value.slice(this.textarea.selectionEnd).includes('\n');
	}

	/** 送信履歴をたどる。direction 1 = 古い方へ、-1 = 新しい方へ。 */
	private recallHistory(direction: 1 | -1): boolean {
		if (this.token === undefined) {
			return false;
		}
		const history = this.host.getHistory(this.token);
		const next = this.historyIndex + direction;
		if (next < -1 || next >= history.length) {
			return false;
		}
		if (this.historyIndex === -1) {
			this.historyDraft = this.textarea.value;
		}
		this.historyIndex = next;
		this.textarea.value = next === -1 ? this.historyDraft : history[history.length - 1 - next];
		const end = this.textarea.value.length;
		this.textarea.setSelectionRange(end, end);
		this.autosize();
		this.updateSendState();
		return true;
	}

	private submit(): void {
		const text = this.textarea.value;
		if (text.trim().length === 0 || this.blockedReason !== undefined || this.sending) {
			return;
		}
		this.hideSlashMenu();
		this._onDidSubmit.fire(text);
	}

	// ---- スラッシュコマンドの補完 --------------------------------------------------------------

	private updateSlashMenu(): void {
		const query = paradisAgentChatSlashQuery(this.textarea.value, this.textarea.selectionStart);
		const token = this.token;
		if (query === undefined || token === undefined) {
			this.hideSlashMenu();
			return;
		}
		const request = ++this.slashRequest;
		this.host.getCommands(token).then(commands => {
			if (request !== this.slashRequest || this._store.isDisposed) {
				return;
			}
			this.slashItems = paradisFilterAgentChatCommands(commands, query).slice(0, SLASH_MENU_LIMIT);
			this.slashDuplicates = paradisDuplicateAgentChatCommandNames(commands);
			this.slashSelected = 0;
			this.renderSlashMenu();
		}, () => this.hideSlashMenu());
	}

	private renderSlashMenu(): void {
		this.slashRowListeners.clear();
		clearNode(this.slashMenu);
		if (this.slashItems.length === 0) {
			this.slashMenu.style.display = 'none';
			return;
		}
		this.slashMenu.style.display = '';
		this.slashItems.forEach((command, index) => {
			const row = append(this.slashMenu, $('.paradis-agent-chat-slash-item'));
			row.setAttribute('role', 'option');
			row.classList.toggle('selected', index === this.slashSelected);
			row.setAttribute('aria-selected', String(index === this.slashSelected));
			append(row, $('span.paradis-agent-chat-slash-name')).textContent = `/${command.name}`;
			if (command.argumentHint !== undefined) {
				append(row, $('span.paradis-agent-chat-slash-args')).textContent = command.argumentHint;
			}
			if (this.slashDuplicates.has(command.name.toLocaleLowerCase())) {
				append(row, $('span.paradis-agent-chat-slash-args')).textContent = paradisAgentChatCommandOrigin(command);
			}
			append(row, $('span.paradis-agent-chat-slash-description')).textContent = command.description;
			// クリックで確定する。mousedown で取らないと、先に textarea の blur が走ってメニューが閉じる。
			this.slashRowListeners.add(addDisposableListener(row, EventType.MOUSE_DOWN, e => {
				e.preventDefault();
				this.acceptSlash(index);
			}));
		});
	}

	private moveSlashSelection(delta: number): void {
		this.slashSelected = (this.slashSelected + delta + this.slashItems.length) % this.slashItems.length;
		this.renderSlashMenu();
		this.slashMenu.children[this.slashSelected]?.scrollIntoView({ block: 'nearest' });
	}

	private acceptSlash(index: number): void {
		const command = this.slashItems[index];
		if (command === undefined) {
			return;
		}
		const insert = command.insertText.startsWith('/') ? command.insertText : `/${command.insertText}`;
		const rest = this.textarea.value.slice(this.textarea.selectionEnd);
		this.textarea.value = `${insert} ${rest.trimStart()}`;
		const caret = insert.length + 1;
		this.textarea.setSelectionRange(caret, caret);
		this.onInput();
		this.textarea.focus();
	}

	private hideSlashMenu(): void {
		this.slashRequest++;
		this.slashItems = [];
		this.slashMenu.style.display = 'none';
		this.slashRowListeners.clear();
		clearNode(this.slashMenu);
	}
}

/** 同じ名前の候補に添える出どころ（組み込み・プラグイン名・自作・MCP）。 */
function paradisAgentChatCommandOrigin(command: IParadisAgentChatCommand): string {
	switch (command.source) {
		case 'built-in': return localize('paradisAgentChat.slashOrigin.builtIn', "Built-in");
		case 'plugin': return command.plugin ?? localize('paradisAgentChat.slashOrigin.plugin', "Plugin");
		case 'mcp': return localize('paradisAgentChat.slashOrigin.mcp', "MCP");
		default: return localize('paradisAgentChat.slashOrigin.custom', "Custom");
	}
}
