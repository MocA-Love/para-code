/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの詳細。ステータスバーの項目から開く。
//
// ここに出すものは「アプリの外で何が起きているか」に絞る。ターミナルの一覧そのものは
// ターミナルのタブが見せるので、ここが答えるのは **閉じても残っているのか / どれだけ残って
// いるのか / 古いものが居座っていないか** の3つだけ。
//
// 止める・立て直すはここから呼ぶが、押した先で必ず確認を出す。どちらも抱えているターミナルを
// 全部失う操作で、しかも失うのは「閉じても残したかったから常駐にした作業」なので、
// 取り消せない操作の中でも重い部類になる。

import './media/paradisPtyDaemon.css';
import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import {
	IParadisPtyDaemonStatus,
	IParadisPtyDaemonStatusService,
	paradisFormatUptime,
	paradisShortBuildId,
} from '../common/paradisPtyDaemonStatus.js';
import { PARADIS_PTY_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';

const $ = dom.$;

const POPOVER_WIDTH = 336;
const POPOVER_MARGIN = 8;

export interface IParadisPtyDaemonPopoverOptions {
	readonly status: IParadisPtyDaemonStatus;
	readonly service: IParadisPtyDaemonStatusService;
	readonly onClose: () => void;
	readonly onDidAct: () => void;
}

export class ParadisPtyDaemonPopover extends Disposable {

	private readonly element: HTMLElement;
	private readonly bodyListeners = this._register(new DisposableStore());
	private status: IParadisPtyDaemonStatus;
	/** 直前に描いた内容。同じなら描き直さない（{@link update} 参照）。 */
	private signature: string | undefined;

	constructor(
		private readonly anchor: HTMLElement,
		private readonly options: IParadisPtyDaemonPopoverOptions,
		@ILayoutService layoutService: ILayoutService,
		@IDialogService private readonly dialogService: IDialogService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
	) {
		super();
		this.status = options.status;

		this.element = $('.paradis-pty-daemon-popover');
		this.element.style.width = `${POPOVER_WIDTH}px`;
		this.element.tabIndex = -1;
		layoutService.activeContainer.appendChild(this.element);
		this.render();
		this.reposition();
		this.element.focus();

		const targetWindow = dom.getWindow(this.element);
		this._register(dom.addDisposableListener(targetWindow, 'resize', () => this.reposition()));
		this._register(dom.addDisposableListener(targetWindow, 'mousedown', e => this.onWindowMouseDown(e), true));
		this._register(dom.addDisposableListener(this.element, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.options.onClose();
			}
		}));
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	update(status: IParadisPtyDaemonStatus): void {
		this.status = status;
		// 中身が変わっていなければ描き直さない。開いている間は数秒ごとに更新が来るので、毎回
		// 作り直すと**キーボードで辿ったフォーカスが `<body>` へ落ち**、Escape も効かなくなる。
		// ポインタの下のボタンのホバーも消え、高さが変われば位置も跳ねる。
		const signature = JSON.stringify([
			status.enabled, status.running, status.terminalCount, status.spaces,
			status.foreign.map(foreign => foreign.pid), status.pid, status.buildId,
		]);
		if (signature === this.signature) {
			return;
		}
		this.signature = signature;
		this.render();
		this.reposition();
	}

	private onWindowMouseDown(e: MouseEvent): void {
		const target = e.target as Node | null;
		if (!target || dom.isAncestor(target, this.element) || dom.isAncestor(target, this.anchor)) {
			return;
		}
		this.options.onClose();
	}

	/** ステータスバーの項目の真上に、画面からはみ出さない位置で置く。 */
	private reposition(): void {
		const anchorRect = this.anchor.getBoundingClientRect();
		const containerRect = this.element.parentElement?.getBoundingClientRect();
		const width = this.element.offsetWidth || POPOVER_WIDTH;
		const height = this.element.offsetHeight;
		const maxLeft = (containerRect?.width ?? width) - width - POPOVER_MARGIN;
		const left = Math.max(POPOVER_MARGIN, Math.min(anchorRect.right - width, maxLeft));
		const top = Math.max(POPOVER_MARGIN, anchorRect.top - height - 4);
		this.element.style.left = `${Math.round(left)}px`;
		this.element.style.top = `${Math.round(top)}px`;
	}

	/**
	 * 抱えているものを本体に据える。
	 *
	 * このパネルを開く理由は「何が残っているか」で、稼働時間や pid はそのついでに見るもの。
	 * 見出しに合計、本体にスペースごとの内訳、下に補足という並びにしてある。以前は逆で、
	 * 本数が文章の中に埋もれ、pid とコミットハッシュが場所の半分を取っていた。
	 */
	private render(): void {
		this.bodyListeners.clear();
		dom.clearNode(this.element);

		const running = this.status.running;

		const head = dom.append(this.element, $('.ppd-head'));
		dom.append(head, $('.ppd-title')).textContent = localize('paradis.ptyDaemon.popover.title', "常駐ターミナル");
		const state = dom.append(head, $(running ? '.ppd-state' : '.ppd-state.ppd-bad'));
		dom.append(state, $('.ppd-dot'));
		dom.append(state, $('span')).textContent = running
			? localize('paradis.ptyDaemon.popover.running', "稼働中")
			: localize('paradis.ptyDaemon.popover.stopped', "停止中");
		dom.append(head, $('.ppd-total')).textContent = this.status.terminalCount === undefined
			? '—'
			: localize('paradis.ptyDaemon.popover.count', "{0}本", this.status.terminalCount);

		if (this.status.spaces.length > 0) {
			dom.append(this.element, $('.ppd-sep'));
			const rows = dom.append(this.element, $('.ppd-rows'));
			for (const space of this.status.spaces) {
				const row = dom.append(rows, $('.ppd-row'));
				dom.append(row, $('.ppd-name')).textContent = space.name;
				dom.append(row, $('.ppd-count')).textContent = localize('paradis.ptyDaemon.popover.count', "{0}本", space.count);
			}
		} else {
			// 並べるものが無いときだけ、なぜ空なのかを本体に書く。ここは補足ではなく本体なので、
			// 脚注の色にしない。
			dom.append(this.element, $('.ppd-empty')).textContent = this.leadText();
		}

		if (!running) {
			this.appendAlert(
				true,
				localize('paradis.ptyDaemon.popover.notRunningTitle', "常駐していません"),
				localize('paradis.ptyDaemon.popover.notRunningSub', "いまのターミナルは Para Code の中で動いているので、閉じると終了します。次にターミナルを開くと常駐を立て直します。"),
				[],
			);
		}

		for (const foreign of this.status.foreign) {
			this.appendAlert(
				false,
				localize('paradis.ptyDaemon.popover.foreignTitle', "古いバージョンの常駐が残っています"),
				this.foreignSubText(foreign.buildId, foreign.startedAt),
				[{
					label: localize('paradis.ptyDaemon.popover.foreignStop', "停止"),
					run: () => this.confirmAndStopForeign(foreign.pid, foreign.buildId),
				}],
			);
		}

		const meta = this.metaText();
		const lead = running && this.status.spaces.length > 0 ? this.leadText() : undefined;
		if (meta !== undefined || lead !== undefined) {
			dom.append(this.element, $('.ppd-sep'));
			const foot = dom.append(this.element, $('.ppd-foot'));
			if (lead !== undefined) {
				dom.append(foot, $('div')).textContent = lead;
			}
			if (meta !== undefined) {
				dom.append(foot, $('.ppd-meta')).textContent = meta;
			}
		}

		const actions = dom.append(this.element, $('.ppd-actions'));
		if (running) {
			this.appendButton(actions, localize('paradis.ptyDaemon.popover.restart', "再起動"), false, () => this.confirmAndRestart());
			this.appendButton(actions, localize('paradis.ptyDaemon.popover.stop', "停止"), false, () => this.confirmAndStop());
		}
		dom.append(actions, $('.ppd-spacer'));
		this.appendButton(actions, localize('paradis.ptyDaemon.popover.settings', "設定"), true, () => {
			this.options.onClose();
			return this.preferencesService.openSettings({ query: PARADIS_PTY_DAEMON_ENABLED });
		});
	}

	/**
	 * 古い常駐の説明。
	 *
	 * 経過時間は分からないことがある (時計が進んだ後など、`paradisFormatUptime` が「不明」を
	 * 返す)。そのまま差し込むと「**不明前から**」という読めない日本語になるので、分からない
	 * ときは時間の話ごと落とす。
	 */
	private foreignSubText(buildId: string, startedAt: number): string {
		const elapsed = Date.now() - startedAt;
		const build = paradisShortBuildId(buildId);
		if (!isFinite(elapsed) || elapsed < 0) {
			return localize('paradis.ptyDaemon.popover.foreignSubPlain', "{0}。更新前に残したターミナルはこちらにいます。", build);
		}
		return localize('paradis.ptyDaemon.popover.foreignSub', "{0} · {1}前から。更新前に残したターミナルはこちらにいます。", build, paradisFormatUptime(elapsed));
	}

	/**
	 * 下に1行で添える素性。困ったときに要るもので、普段は読み飛ばしてよい。
	 *
	 * 停止中は返さない。そのとき `pid` も `buildId` も無い (どれも動いている常駐の台帳から
	 * 来る) ので、出しても「—」だけの行が1本増えるだけになる。
	 */
	private metaText(): string | undefined {
		if (!this.status.running) {
			return undefined;
		}
		const uptime = this.status.startedAt === undefined ? '—' : paradisFormatUptime(Date.now() - this.status.startedAt);
		const pid = this.status.pid === undefined ? '—' : String(this.status.pid);
		return localize('paradis.ptyDaemon.popover.meta', "稼働 {0} · pid {1} · {2}", uptime, pid, paradisShortBuildId(this.status.buildId));
	}

	private leadText(): string {
		if (!this.status.running) {
			return localize('paradis.ptyDaemon.popover.leadStopped', "常駐が動いていません。設定は有効ですが、いまはターミナルを Para Code の中で動かしています。");
		}
		if (this.status.terminalCount === undefined) {
			// **「ありません」と言わない。** 聞けなかっただけで、抱えていないとは限らない。
			return localize('paradis.ptyDaemon.popover.leadUnknown', "常駐は動いていますが、いま何を抱えているかを聞き出せていません。しばらくすると取り直します。");
		}
		if (this.status.terminalCount === 0) {
			return localize('paradis.ptyDaemon.popover.leadIdle', "常駐は動いていますが、抱えているターミナルはありません。このまま誰も使わなければ、しばらくして自分から終了します。");
		}
		// 「残ります」と言い切らず「残せます」にしてある。閉じるときに残すかどうかは設定
		// (`keepAliveOnClose`) と、尋ねたときの答え次第で、`never` にしている人には嘘になる。
		return localize('paradis.ptyDaemon.popover.leadRunning', "{0}本のターミナルを、Para Code の外の常駐が抱えています。ウィンドウを閉じても Para Code を終了しても、実行したまま残せます。", this.status.terminalCount);
	}

	private appendAlert(isError: boolean, title: string, sub: string, buttons: readonly { label: string; run: () => unknown }[]): void {
		const alert = dom.append(this.element, $(isError ? '.ppd-alert.ppd-alert-error' : '.ppd-alert'));
		dom.append(alert, $('.ppd-alert-title')).textContent = title;
		dom.append(alert, $('.ppd-alert-sub')).textContent = sub;
		if (buttons.length > 0) {
			const row = dom.append(alert, $('.ppd-actions'));
			row.style.padding = '8px 0 0';
			for (const button of buttons) {
				this.appendButton(row, button.label, true, button.run);
			}
		}
	}

	private appendButton(parent: HTMLElement, label: string, mini: boolean, run: () => unknown): void {
		const button = dom.append(parent, $(mini ? 'button.ppd-button.ppd-mini' : 'button.ppd-button'));
		button.textContent = label;
		this.bodyListeners.add(dom.addDisposableListener(button, 'click', e => {
			e.preventDefault();
			void run();
		}));
	}

	/**
	 * 失うものを数字で見せてから確かめる。
	 *
	 * 「本当によろしいですか」だけでは、押す人は自分が何を失うのか分からない。常駐にした人に
	 * とっては、この数字こそが確かめたいことなので、必ず出す。
	 */
	private async confirm(message: string, primaryButton: string): Promise<boolean> {
		const count = this.status.terminalCount;
		// 分からないときに「ありません」と言わない。聞けなかっただけで、抱えていないとは
		// 限らない。**押した結果が取り返しのつかない操作**なので、ここで嘘をつくのが一番まずい。
		const detail = count === undefined
			? localize('paradis.ptyDaemon.confirm.detailUnknown', "動いているターミナルはすべて終了します。何本抱えているかは、いま聞き出せていません。実行中のコマンドやエージェントも一緒に終わり、元には戻せません。")
			: count === 0
				? localize('paradis.ptyDaemon.confirm.detailEmpty', "いま抱えているターミナルはありません。")
				: localize('paradis.ptyDaemon.confirm.detail', "動いている{0}本のターミナルが終了します。実行中のコマンドやエージェントも一緒に終わり、元には戻せません。", count);
		const { confirmed } = await this.dialogService.confirm({ type: Severity.Warning, message, detail, primaryButton });
		return confirmed;
	}

	private async confirmAndRestart(): Promise<void> {
		if (!await this.confirm(
			localize('paradis.ptyDaemon.confirm.restart', "常駐ターミナルを再起動しますか?"),
			localize('paradis.ptyDaemon.confirm.restartButton', "再起動"),
		)) {
			return;
		}
		await this.options.service.restart();
		this.options.onDidAct();
	}

	private async confirmAndStop(): Promise<void> {
		if (!await this.confirm(
			localize('paradis.ptyDaemon.confirm.stop', "常駐ターミナルを停止しますか?"),
			localize('paradis.ptyDaemon.confirm.stopButton', "停止"),
		)) {
			return;
		}
		await this.options.service.stop();
		this.options.onDidAct();
	}

	/**
	 * 古い常駐を止める。**本数を数字で出さない**のは、こちらからは分からないから。
	 * 分からないことを 0 と書くのが一番危ない。
	 */
	private async confirmAndStopForeign(pid: number, buildId: string): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message: localize('paradis.ptyDaemon.confirm.foreign', "古いバージョンの常駐を停止しますか?"),
			detail: localize('paradis.ptyDaemon.confirm.foreignDetail', "{0} が抱えているターミナルはすべて終了します。何本残っているかは、こちらからは分かりません。", paradisShortBuildId(buildId)),
			primaryButton: localize('paradis.ptyDaemon.confirm.foreignButton', "停止"),
		});
		if (!confirmed) {
			return;
		}
		await this.options.service.stopForeign(pid);
		this.options.onDidAct();
	}
}
