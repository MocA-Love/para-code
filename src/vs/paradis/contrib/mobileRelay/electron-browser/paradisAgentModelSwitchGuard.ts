/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import { stripTerminalControls } from '../common/paradisAgentTerminalHints.js';

// モバイル注入後にダイアログ描画を待つ猶予。Claude TUIは Enter 送信後にダイアログを
// 描画するため、往復遅延・描画遅延を見込んで長めに取る。過ぎたら購読は破棄する。
const WATCH_DURATION_MS = 15_000;
// 確認ダイアログが出るのは限られた条件（会話に出力あり・未ack・ベースモデルが実際に
// 変わる切替）のみで、`/effort` の引数付きや同一ベースモデルへの `/model` は即時適用で
// ダイアログを出さない。この猶予内にダイアログが現れなければ「確認不要で適用済み」として
// 成功へ倒す（ダイアログ待ちタイムアウト＝失敗にすると、成功した切替を失敗と誤報する）。
const NO_DIALOG_GRACE_MS = 5_000;
// 走査バッファ上限。タイトル文言が収まれば十分なので小さく抑える。
const SCAN_BUFFER_LIMIT = 8_192;
// モバイルから注入されたコマンドのうち、ダイアログを誘発しうるもの。引数付きの
// `/model <id>` / `/effort <level>` のみを対象にする（引数なしはピッカーが開くだけで
// 確認ダイアログは出ないため、誤って Enter を送らないよう除外する）。
const MODEL_SWITCH_COMMAND = /^\/(?:model|effort)\s+\S/;
// ダイアログのタイトル文言（Claude Code 2.1.207）。model 切替は "Switch model?"、
// effort 切替は "Change effort level?"。ANSI を除去した後に照合する。
const CONFIRM_TITLE = /switch model\?|change effort level\?/i;
// 確認が描かれてから Enter を送るまでの待ち。Claude Code 2.1.326 の選択肢の一覧は、最初の描画から 150ms 未満に
// 押し始めたキーを打ち間違いとして捨てる（バイナリの判定式。実機の 2 回の切り替えでは捨てられなかった）。
// 2026-11-26 に 2.1.326 と 2.1.332 で測り直した（代役の API、各 5 回）: 「Switch model?」は描画から 0・50・100・150・200ms の
// Enter をどれも受け付け、この待ちでも 1 回で閉じた。待ちは害が無いので残す（確認は送信の Enter から 30ms ほどで描かれる）。
const CONFIRM_SETTLE_MS = 200;
// 直前の Enter（コマンドの送信）から次の Enter までの間。2.1.326 は同じキーを 700ms 以内に続けると、前の打鍵の続きとして
// 押し始めを前の時刻に揃えるので、上の 150ms の判定に当たる。
const CONFIRM_ENTER_GAP_MS = 750;
// Enter を送ってから、確認の題名が画面から消えたかを見るまでの待ち。消えていなければ 1 回だけ送り直す。
const CONFIRM_RECHECK_MS = 1_000;
// Ctrl+U（行頭まで削除）。前回の失敗で入力欄に残ったコマンド文字列の掃除に使う。
// 空行なら無害で、実行中ターンを中断しうる Esc のような副作用がない。PCユーザーが
// 同じペインで打ちかけていた未送信テキストは消えるが、消さなくても直後の貼り付けが
// 同じ行へ連結されてどのみち壊れるため、掃除して確実に実行できる状態を優先する。
const CLEAR_INPUT_LINE = '\u0015';

/**
 * ガードが必要とする最小のターミナル面（`ITerminalInstance` がそのまま満たす）。
 * テストでフェイクを渡せるよう構造的に絞ってある。
 */
export interface IParadisModelSwitchTerminal {
	readonly instanceId: number;
	readonly onData: Event<string>;
	sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void>;
}

/** ガードの待ち時間（テストで短くする）。省いたものは既定値。 */
export interface IParadisModelSwitchGuardTiming {
	readonly watchMs: number;
	readonly graceMs: number;
	readonly settleMs?: number;
	readonly enterGapMs?: number;
	readonly recheckMs?: number;
}

/**
 * モバイル発の `/model` / `/effort` 切替でClaude TUIが出す確認ダイアログを、注入直後の
 * 時限ウォッチ中に限って自動確定（Enter送出）する。
 *
 * PCでユーザー自身が操作して出したダイアログには介入しない（モバイル注入を起点にした
 * 時限ウォッチの中でしか発火しないことで担保する）。
 *
 * Enter は確認が描かれてから少し待って送る（{@link CONFIRM_SETTLE_MS}・{@link CONFIRM_ENTER_GAP_MS}）。画面を読めるときは、
 * 送った後に確認の題名が消えたかで成功を決め、残っていれば 1 回だけ送り直す（1 回のウォッチで Enter は最大 2 回）。
 */
export class ParadisAgentModelSwitchGuard extends Disposable {
	// ターミナルinstanceId → 進行中ウォッチのdisposable群（onData購読 + 期限タイマー）。
	private readonly watches = this._register(new DisposableMap<number>());

	constructor(
		private readonly logService: ILogService,
		private readonly timing: IParadisModelSwitchGuardTiming = { watchMs: WATCH_DURATION_MS, graceMs: NO_DIALOG_GRACE_MS },
	) {
		super();
	}

	/**
	 * モバイルから注入された生入力を検査し、切替コマンドならウォッチを開始する。
	 * `\r` 単独やそれ以外の入力では何もしない（コマンド文字列でのみ武装する）。`readScreen` を渡すと、確認が消えたかを見て
	 * 1 回だけ送り直す。
	 */
	maybeArm(instance: IParadisModelSwitchTerminal, data: string, readScreen?: () => string): void {
		if (!MODEL_SWITCH_COMMAND.test(data.trimStart())) {
			return;
		}
		this.arm(instance, undefined, readScreen);
	}

	/**
	 * Agent Action用。コマンド送信から確認ダイアログの決着（自動確定または確認不要の確定）までを1つのPromiseで追跡する。
	 * `readScreen`（見えている範囲の文字）を渡すと、Enter の後に確認の題名が消えたことで成功を決める。
	 */
	async execute(instance: IParadisModelSwitchTerminal, command: string, validate: () => Promise<boolean>, delay?: () => Promise<void>, readScreen?: () => string): Promise<void> {
		if (!MODEL_SWITCH_COMMAND.test(command.trimStart())) {
			throw new Error('Unsupported Claude setting command');
		}
		// 前回の失敗（Enter取りこぼし等）で入力欄に残ったコマンド文字列を先に掃除する。
		// 掃除しないと今回の貼り付けが同じ行へ追記され `/model … /model …` と連結される。
		await instance.sendText(CLEAR_INPUT_LINE, false);
		let watch: { readonly cancel: () => void; readonly submitted: () => void } = { cancel: () => { }, submitted: () => { } };
		const confirmation = new Promise<void>((resolve, reject) => { watch = this.arm(instance, { resolve, reject, validate }, readScreen); });
		const cancel = () => watch.cancel();
		// 貼り付け中にウォッチが破棄された場合の reject を unhandled rejection にしない
		// （結果自体は下の await confirmation で受け取る）。
		confirmation.catch(() => undefined);
		let outcome: { readonly consumed: boolean; readonly executed: boolean };
		try {
			// 通常メッセージ送信と同じく「貼り付け → 猶予 → Enter」に分離する。一括送信だと
			// TUIが貼り付け処理中の Enter を取りこぼし、コマンドが入力欄に残ったまま
			// ダイアログ待ちだけが走ってタイムアウトする。
			outcome = await paradisSendAgentMessageToTui(command, (text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode), validate, delay);
			watch.submitted();
		} catch (error) {
			cancel();
			await confirmation.catch(() => undefined);
			throw error;
		}
		if (!outcome.executed) {
			cancel();
			await confirmation.catch(() => undefined);
			throw new Error('Claude setting session changed before submission');
		}
		await confirmation;
	}

	private arm(instance: IParadisModelSwitchTerminal, completion?: { resolve: () => void; reject: (error: Error) => void; validate?: () => Promise<boolean> }, readScreen?: () => string): { readonly cancel: () => void; readonly submitted: () => void } {
		const id = instance.instanceId;
		const store = new DisposableStore();
		const disposeOwnWatch = () => {
			if (this.watches.get(id) === store) {
				this.watches.deleteAndDispose(id);
			}
		};
		let buffer = '';
		let confirming = false;
		// 最後に Enter を送った時刻（コマンドの送信の Enter。execute が送った後に更新する）
		let lastEnterAt = Date.now();
		const sleep = (ms: number) => new Promise<void>(resolve => {
			const handle = setTimeout(resolve, Math.max(0, ms));
			store.add(toDisposable(() => clearTimeout(handle)));
		});
		const stillOwn = async () => this.watches.get(id) === store && await Promise.resolve(completion?.validate?.() ?? true) && this.watches.get(id) === store;
		const sendEnter = async () => {
			if (!(await stillOwn())) {
				throw new Error('Claude setting session changed before confirmation');
			}
			lastEnterAt = Date.now();
			await instance.sendText('\r', false);
		};
		const titleShown = () => readScreen !== undefined && CONFIRM_TITLE.test(readScreen());
		const confirm = async (seenAt: number) => {
			await sleep(Math.max(seenAt + (this.timing.settleMs ?? CONFIRM_SETTLE_MS), lastEnterAt + (this.timing.enterGapMs ?? CONFIRM_ENTER_GAP_MS)) - Date.now());
			await sendEnter();
			if (readScreen === undefined) {
				return;
			}
			await sleep(this.timing.recheckMs ?? CONFIRM_RECHECK_MS);
			if (!titleShown()) {
				return;
			}
			// 確認が残っている（Enter が捨てられた）。1 回だけ送り直し、消えなければ失敗にする
			this.logService.info('[paradisMobileRelay] model switch confirmation still open; sending enter once more');
			await sendEnter();
			await sleep(this.timing.recheckMs ?? CONFIRM_RECHECK_MS);
			if (titleShown()) {
				throw new Error('Claude setting confirmation did not close');
			}
		};
		let resolved = false;
		const settle = (error?: Error) => {
			if (resolved) {
				return;
			}
			resolved = true;
			if (error !== undefined) {
				completion?.reject(error);
			} else {
				completion?.resolve();
			}
		};
		store.add(toDisposable(() => settle(new Error('Claude setting confirmation was cancelled'))));

		store.add(instance.onData(chunk => {
			if (confirming) {
				return;
			}
			// 生データのまま連結してから strip する（エスケープ列がチャンク境界で
			// 分断されても除去漏れしないように）。
			buffer = (buffer + chunk).slice(-SCAN_BUFFER_LIMIT);
			if (!CONFIRM_TITLE.test(stripTerminalControls(buffer))) {
				return;
			}
			confirming = true;
			// フォーカス既定は "Yes" 側なので Enter で確定できる。
			confirm(Date.now()).then(() => {
				settle();
				// 確定したらウォッチ終了（購読・タイマーを破棄。二重確定を防ぐ）。
				disposeOwnWatch();
			}).catch(err => {
				settle(err instanceof Error ? err : new Error(String(err)));
				this.logService.warn('[paradisMobileRelay] model switch auto-confirm failed', err);
				disposeOwnWatch();
			});
		}));

		if (completion !== undefined) {
			// 猶予内にダイアログが現れなければ確認不要の切替として成功で決着させる。
			// 遅れて出るダイアログに備え、ウォッチ自体は満了（watchMs）まで維持して
			// 自動確定だけは引き続き行う（放置するとダイアログが端末を塞いだままになる）。
			const graceTimer = setTimeout(() => {
				if (!confirming) {
					settle();
				}
			}, this.timing.graceMs);
			store.add(toDisposable(() => clearTimeout(graceTimer)));
		}

		const timer = setTimeout(() => disposeOwnWatch(), this.timing.watchMs);
		store.add(toDisposable(() => clearTimeout(timer)));

		// 同一端末で連続切替した場合は前回ウォッチを破棄して張り直す（DisposableMap.set は
		// 上書き時に旧値を dispose する）。
		this.watches.set(id, store);
		return { cancel: disposeOwnWatch, submitted: () => { lastEnterAt = Date.now(); } };
	}
}
