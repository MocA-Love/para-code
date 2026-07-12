/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { stripTerminalControls } from './paradisAgentTerminalHints.js';

// モバイル注入後にダイアログ描画を待つ猶予。Claude TUIは Enter 送信後にダイアログを
// 描画するため、往復遅延・描画遅延を見込んで長めに取る。過ぎたら購読は破棄する。
const WATCH_DURATION_MS = 15_000;
// 走査バッファ上限。タイトル文言が収まれば十分なので小さく抑える。
const SCAN_BUFFER_LIMIT = 8_192;
// モバイルから注入されたコマンドのうち、ダイアログを誘発しうるもの。引数付きの
// `/model <id>` / `/effort <level>` のみを対象にする（引数なしはピッカーが開くだけで
// 確認ダイアログは出ないため、誤って Enter を送らないよう除外する）。
const MODEL_SWITCH_COMMAND = /^\/(?:model|effort)\s+\S/;
// ダイアログのタイトル文言（Claude Code 2.1.207）。model 切替は "Switch model?"、
// effort 切替は "Change effort level?"。ANSI を除去した後に照合する。
const CONFIRM_TITLE = /switch model\?|change effort level\?/i;

/**
 * モバイル発の `/model` / `/effort` 切替でClaude TUIが出す確認ダイアログを、注入直後の
 * 時限ウォッチ中に限って自動確定（Enter送出）する。
 *
 * PCでユーザー自身が操作して出したダイアログには介入しない（モバイル注入を起点にした
 * 時限ウォッチの中でしか発火しないことで担保する）。1回のウォッチで Enter は最大1回。
 */
export class ParadisAgentModelSwitchGuard extends Disposable {
	// ターミナルinstanceId → 進行中ウォッチのdisposable群（onData購読 + 期限タイマー）。
	private readonly watches = this._register(new DisposableMap<number>());

	constructor(private readonly logService: ILogService) {
		super();
	}

	/**
	 * モバイルから注入された生入力を検査し、切替コマンドならウォッチを開始する。
	 * `\r` 単独やそれ以外の入力では何もしない（コマンド文字列でのみ武装する）。
	 */
	maybeArm(instance: ITerminalInstance, data: string): void {
		if (!MODEL_SWITCH_COMMAND.test(data.trimStart())) {
			return;
		}
		this.arm(instance);
	}

	private arm(instance: ITerminalInstance): void {
		const id = instance.instanceId;
		const store = new DisposableStore();
		let buffer = '';
		let confirmed = false;

		store.add(instance.onData(chunk => {
			if (confirmed) {
				return;
			}
			// 生データのまま連結してから strip する（エスケープ列がチャンク境界で
			// 分断されても除去漏れしないように）。
			buffer = (buffer + chunk).slice(-SCAN_BUFFER_LIMIT);
			if (!CONFIRM_TITLE.test(stripTerminalControls(buffer))) {
				return;
			}
			confirmed = true;
			// フォーカス既定は "Yes" 側なので Enter 1回で確定できる。
			instance.sendText('\r', false)
				.catch(err => this.logService.warn('[paradisMobileRelay] model switch auto-confirm failed', err));
			// 確定したらウォッチ終了（購読・タイマーを破棄。二重確定を防ぐ）。
			this.watches.deleteAndDispose(id);
		}));

		const timer = setTimeout(() => this.watches.deleteAndDispose(id), WATCH_DURATION_MS);
		store.add(toDisposable(() => clearTimeout(timer)));

		// 同一端末で連続切替した場合は前回ウォッチを破棄して張り直す（DisposableMap.set は
		// 上書き時に旧値を dispose する）。
		this.watches.set(id, store);
	}
}
