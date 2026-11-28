/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の会話のペインは、タブを閉じても止めずに隠す（報告書の D4 (a)）。
//
// - このウィンドウの Bot の会話のペイン（instanceId）を「閉じても隠すターミナル」の台帳
//   （workspaceSwitch/browser/paradisTerminalHideOnClose.ts）に控える。起動したときと、Bot の様子が変わったときに
//   ParadisBotsWindowWorker が足す。upstream の `terminalEditorInput.ts` の `confirm()` の PARA-PATCH がその台帳を読み、
//   「実行中のプロセスを終了しますか？」を出さずに閉じてよいと答える。
// - 閉じる直前（エディタグループの onWillCloseEditor）に入力からターミナルを外し（dispose しても終わらない）、閉じ終えて
//   から upstream の裏の置き場所（`ITerminalService.moveToBackground`）へ移す。開き直すときは
//   {@link paradisShowHiddenBotPane} で戻す。

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { EditorCloseContext } from '../../../../workbench/common/editor.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { paradisIsTerminalHiddenOnClose } from '../../workspaceSwitch/browser/paradisTerminalHideOnClose.js';

/** 閉じて裏に回した Bot の会話のペイン。 */
const hiddenPanes = new Map<number, { readonly instance: ITerminalInstance; readonly listener: IDisposable }>();

/**
 * 閉じるタブのターミナルを、終わらせずに裏へ回すか。ユーザーが閉じた（MOVE・置き換えではない）Bot の会話のペインだけ。
 * スペースの切り替え（タブを外して持ち越す）と終了の途中は触らない。
 */
export function paradisBotPaneHidesOnClose(facts: { readonly context: EditorCloseContext; readonly shuttingDown: boolean; readonly switching: boolean; readonly instance: Pick<ITerminalInstance, 'instanceId' | 'isDisposed'> }): boolean {
	return facts.context === EditorCloseContext.UNKNOWN && !facts.shuttingDown && !facts.switching && !facts.instance.isDisposed && paradisIsTerminalHiddenOnClose(facts.instance.instanceId);
}

/** Bot の会話のペインを、利用者がどう使っているか（ウィンドウの側で見る）。 */
export interface IParadisBotPaneUse {
	/** エディタのタブとして見えている。 */
	readonly visible: boolean;
	/** フォーカスがある。 */
	readonly focused: boolean;
	/** 送っていない打ちかけの入力がある（最後の入力が Enter で終わっていない）。 */
	readonly draft: boolean;
	/** 最後にターミナルへ出力があった時刻（エージェントが動いている間は出力が続く）。 */
	readonly lastOutputAt?: number;
	/** 最後に見えなくなった時刻。 */
	readonly lastHiddenAt?: number;
}

/**
 * 何もしない 30 分の停止で、このペインを止めてよいか。見えている・フォーカスがある・打ちかけがあるペインは止めない。
 * 数え始めは、最後の出力と最後に見えなくなった時刻の遅い方（最後の発言は shared process の側で数えている）。
 */
export function paradisBotPaneIdleStopAllowed(use: IParadisBotPaneUse, now: number, idleMs: number): boolean {
	if (use.visible || use.focused || use.draft) {
		return false;
	}
	return now - Math.max(use.lastOutputAt ?? 0, use.lastHiddenAt ?? 0) >= idleMs;
}

/**
 * 利用者の入力 1 回分で、入力欄に打ちかけが残りうるかを更新する（入力欄の中身を画面から読めないときの代わり）。
 * 印字できる文字（貼り付けを含む）を打てば立て、Enter で送る・Esc・Ctrl+C で下ろす。矢印・フォーカスの知らせなどの
 * エスケープの並びと、Backspace などの制御文字だけの入力は変えない。
 */
export function paradisBotDraftAfterInput(previous: boolean, data: string): boolean {
	if (data.length === 0) {
		return previous;
	}
	if (/[\r\n]$/.test(data) || data === '\x1b' || data.includes('\x03')) {
		return false;
	}
	const text = data
		.replace(/\x1b\[[0-9;?<>]*[ -\/]*[@-~]/g, '')
		.replace(/\x1bO./g, '')
		.replace(/\x1b./g, '');
	return /[^\x00-\x1f\x7f]/.test(text) ? true : previous;
}

/**
 * 打ちかけがあるか。入力欄の中身を画面から読めればそれで決め（`text` ならある、`empty` なら無い）、読めなければ
 * {@link paradisBotDraftAfterInput} で数えた入力で決める。
 */
export function paradisBotHasDraft(composer: 'empty' | 'text' | 'unknown', typed: boolean): boolean {
	return composer === 'unknown' ? typed : composer === 'text';
}

/** 閉じて裏に回したペインとして控える。 */
export function paradisMarkBotPaneHidden(instance: ITerminalInstance): void {
	forgetHidden(instance.instanceId);
	// 一度だけ聞く（終わった時点で外れる）
	const listener = Event.once(instance.onDisposed)(() => forgetHidden(instance.instanceId));
	hiddenPanes.set(instance.instanceId, { instance, listener });
}

function forgetHidden(instanceId: number): void {
	hiddenPanes.get(instanceId)?.listener.dispose();
	hiddenPanes.delete(instanceId);
}

export function paradisIsBotPaneHidden(instanceId: number): boolean {
	const instance = hiddenPanes.get(instanceId)?.instance;
	return instance !== undefined && !instance.isDisposed;
}

/** 裏に回したペイン（再読み込みの前に閉じる）。 */
export function paradisHiddenBotPanes(): ITerminalInstance[] {
	return [...hiddenPanes.values()].map(entry => entry.instance).filter(instance => !instance.isDisposed);
}

/** 裏に回したペインなら、エディタのタブへ戻す。戻したら true。 */
export async function paradisShowHiddenBotPane(terminalService: Pick<ITerminalService, 'showBackgroundTerminal'>, instance: ITerminalInstance): Promise<boolean> {
	if (!paradisIsBotPaneHidden(instance.instanceId)) {
		return false;
	}
	forgetHidden(instance.instanceId);
	await terminalService.showBackgroundTerminal(instance);
	return true;
}

/** テスト用に台帳を空にする。 */
export function paradisResetBotPaneHideForTest(): void {
	for (const instanceId of [...hiddenPanes.keys()]) {
		forgetHidden(instanceId);
	}
}

/**
 * このウィンドウが Bot のペインを閉じる。このウィンドウが閉じたペインの終わりの知らせ（TerminalExit）は、shared process の
 * 受け口で断られて届かない（実機で確認。シェルが自分で終わったときは届く。断られる理由は未確認）。届かないと結び付けが
 * 残り、異常終了した Bot を開き直すと「まだ動いているかもしれません」で起こせず、「止めて起こし直す」も失敗していた。
 * 閉じたのはこのウィンドウなので、結び付けもここで外す（窓の再読み込みで隠したペインを閉じるときと同じ）。
 */
export async function paradisDisposeBotPane(botsService: { releasePane(paneToken: string): Promise<void> }, token: string | undefined, instance: Pick<ITerminalInstance, 'dispose'>): Promise<void> {
	instance.dispose(TerminalExitReason.User);
	if (token !== undefined) {
		// 外せなくても閉じたことは変わらない（TerminalExit が届けば外れる）
		await botsService.releasePane(token).catch(() => undefined);
	}
}
