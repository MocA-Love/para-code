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
//
// 箱は UI キットの段 3 のポップアップ（paradisPopover.ts）で、ボタンはキットのボタン（paradisButton.ts）。
// role・読み上げの名前・Esc・閉じたあとのフォーカスの戻しはキットが持つ。キットの見出しは文字だけなので、
// 状態の丸と合計は本文の 1 行目に置く。

import './media/paradisPtyDaemon.css';
import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { paradisWatchPopoverDismiss } from '../../../browser/paradisAnchoredPopover.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { showParadisPopover } from '../../../browser/paradisPopover.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import {
	IParadisPtyDaemonStatus,
	IParadisPtyDaemonStatusService,
	paradisFormatUptime,
	paradisShortBuildId,
} from '../common/paradisPtyDaemonStatus.js';
import {
	IParadisDaemonScope,
	paradisDaemonForeignStopTitle,
	paradisDaemonLeadText,
	paradisDaemonNotRunningSub,
	paradisDaemonRestartTitle,
	paradisDaemonScopeLine,
	paradisDaemonSharedHostWarning,
	paradisDaemonStopTitle,
} from '../common/paradisPtyDaemonScope.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';

const $ = dom.$;

const POPOVER_WIDTH = 336;

export interface IParadisPtyDaemonPopoverOptions {
	readonly status: IParadisPtyDaemonStatus;
	/** どの機械の常駐を出しているか。文言と確認ダイアログの両方がこれに従う。 */
	readonly scope: IParadisDaemonScope;
	readonly service: IParadisPtyDaemonStatusService;
	readonly onClose: () => void;
	readonly onDidAct: () => void;
}

export class ParadisPtyDaemonPopover extends Disposable {

	/** 本文の根。キットの本文（`.paradis-popover-body`）の中に置き、描き直すのはこの中だけ。 */
	private readonly element = $('.paradis-pty-daemon-popover');
	private readonly bodyListeners = this._register(new DisposableStore());
	/** 本文の中のボタンを並んだ順に。描き直しのたびに作り直す（{@link update} でフォーカスを戻すのに使う）。 */
	private buttons: HTMLElement[] = [];
	private readonly popover: IDisposable;
	private status: IParadisPtyDaemonStatus;
	/** 直前に描いた内容。同じなら描き直さない（{@link update} 参照）。 */
	private signature: string | undefined;
	/** 自分から閉じている最中。キットの onHide から閉じる知らせを二重に出さない。 */
	private disposing = false;

	constructor(
		anchor: HTMLElement,
		private readonly options: IParadisPtyDaemonPopoverOptions,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.status = options.status;

		this.popover = showParadisPopover(contextViewService, {
			anchor,
			title: localize('paradis.ptyDaemon.popover.title', "常駐ターミナル"),
			render: (body, store) => {
				const box = body.parentElement ?? body;
				box.style.width = `${POPOVER_WIDTH}px`;
				body.appendChild(this.element);
				this.render();
				this.signature = this.computeSignature();
				// ContextView は作業領域の中の押下では閉じないので、外を押したら閉じる（項目の押し直しは開き直しの
				// 操作なので内側）。確認ダイアログなどのモーダルが開いたときも閉じる（小窓の段はモーダルより上）。
				store.add(paradisWatchPopoverDismiss(dom.getWindow(anchor), {
					element: box,
					anchor,
					close: () => this.options.onClose(),
				}));
			},
			onHide: () => {
				if (!this.disposing) {
					this.options.onClose();
				}
			},
		});
	}

	override dispose(): void {
		this.disposing = true;
		this.popover.dispose();
		super.dispose();
	}

	update(status: IParadisPtyDaemonStatus): void {
		this.status = status;
		const signature = this.computeSignature();
		if (signature === this.signature) {
			return;
		}
		this.signature = signature;
		// 稼働時間は 1 分ごとに変わるので、描き直しは開いている間にも起きる。キーボードで居たボタンを
		// 覚えておき、描き直した後に同じ位置のボタンへ戻す（戻さないとフォーカスが `<body>` へ落ちて Esc も効かない）。
		// 並びが変わって同じ位置に別のボタンが来たときは戻さない（押すつもりの無いボタンに居させない）。
		const focused = this.focusedButton();
		this.render();
		if (focused) {
			const button = this.buttons[focused.index];
			if (button?.textContent === focused.label) {
				button.focus();
			}
		}
		// 高さが変わると、上へ折り返して開いた位置がずれるので置き直す
		this.contextViewService.layout();
	}

	/** フォーカスのあるボタンが本文の中で何番目か、とその文字。本文の外・ボタン以外なら undefined。 */
	private focusedButton(): { readonly index: number; readonly label: string | null } | undefined {
		const active = dom.getActiveElement();
		if (!active || !this.element.contains(active)) {
			return undefined;
		}
		const buttons = this.buttons;
		const index = buttons.findIndex(button => button === active || button.contains(active));
		return index === -1 ? undefined : { index, label: buttons[index].textContent };
	}

	/**
	 * いま描くはずの内容。同じなら描き直さない。
	 *
	 * 毎回作り直すと、**キーボードで辿ったフォーカスが `<body>` へ落ちて** Escape も効かなく
	 * なり、ポインタの下のボタンのホバーも消え、高さが変われば位置も跳ねる。
	 *
	 * **見えている文字列そのもので比べる。** 生の状態だけで比べると、稼働時間のように時刻から
	 * 作る文字列が変わっても描き直されず、開いたままのパネルが開いた瞬間の時間を出し続ける
	 * (分単位にしたのは1分ごとに動いてほしいからで、その意図ごと止まる)。
	 */
	private computeSignature(): string {
		return JSON.stringify([
			this.status.enabled,
			this.status.running,
			this.status.terminalCount,
			this.status.spaces,
			this.metaText(),
			this.status.foreign.map(foreign => [foreign.pid, this.foreignSubText(foreign.buildId, foreign.startedAt)]),
		]);
	}

	/**
	 * 抱えているものを本体に据える。
	 *
	 * このパネルを開く理由は「何が残っているか」で、稼働時間や pid はそのついでに見るもの。
	 * 1 行目に合計、本体にスペースごとの内訳、下に補足という並びにしてある。以前は逆で、
	 * 本数が文章の中に埋もれ、pid とコミットハッシュが場所の半分を取っていた。
	 */
	private render(): void {
		this.bodyListeners.clear();
		this.buttons = [];
		dom.clearNode(this.element);

		const running = this.status.running;

		const statusLine = dom.append(this.element, $('.ppd-statusline'));
		const state = dom.append(statusLine, $(running ? '.ppd-state' : '.ppd-state.ppd-bad'));
		dom.append(state, $('.ppd-dot'));
		dom.append(state, $('span')).textContent = running
			? localize('paradis.ptyDaemon.popover.running', "稼働中")
			: localize('paradis.ptyDaemon.popover.stopped', "停止中");
		dom.append(statusLine, $('.ppd-total')).textContent = this.status.terminalCount === undefined
			? '—'
			: localize('paradis.ptyDaemon.popover.count', "{0}本", this.status.terminalCount);

		// **どの機械の話かは、操作より上に置く。** 下の「停止」は接続先の常駐なら接続先の
		// ターミナルを終わらせるので、押す前に読める場所でなければ意味がない。
		const scopeLine = paradisDaemonScopeLine(this.options.scope);
		if (scopeLine !== undefined) {
			dom.append(this.element, $('.ppd-scope')).textContent = scopeLine;
		}

		if (this.status.spaces.length > 0) {
			const rows = dom.append(this.element, $('.ppd-rows'));
			for (const space of this.status.spaces) {
				const row = dom.append(rows, $('.ppd-row'));
				dom.append(row, $('.ppd-name')).textContent = space.name;
				dom.append(row, $('.ppd-count')).textContent = localize('paradis.ptyDaemon.popover.count', "{0}本", space.count);
			}
		} else if (running) {
			// 並べるものが無いときだけ、なぜ空なのかを本体に書く。ここは補足ではなく本体なので、
			// 脚注の色にしない。
			//
			// 停止中はここを出さない。すぐ下の警告が同じことを言うので、ほぼ同じ文が2段落
			// 続くことになる。
			dom.append(this.element, $('.ppd-empty')).textContent = this.leadText();
		}

		if (!running) {
			this.appendAlert(
				true,
				localize('paradis.ptyDaemon.popover.notRunningTitle', "常駐していません"),
				paradisDaemonNotRunningSub(this.options.scope),
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
			// 接続先の常駐を有効にするのは**接続先のマシン設定**で、こちらのユーザー設定では
			// ない。同じ画面を開くと、押した人はここで切ったつもりのまま接続先が変わらない。
			// 接続先に読み手が居る鍵は薄い常駐のものだけなので、開く先もそれに合わせる。
			return this.options.scope.isRemote
				? this.preferencesService.openSettings({ query: PARADIS_PTY_HOST_DAEMON_ENABLED, target: ConfigurationTarget.USER_REMOTE })
				: this.preferencesService.openSettings({ query: PARADIS_PTY_DAEMON_ENABLED });
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

	/** 本体の1行。機械ごとに言うことが変わるので、文言は `paradisPtyDaemonScope.ts` に置いてある。 */
	private leadText(): string {
		return paradisDaemonLeadText(this.options.scope, this.status);
	}

	private appendAlert(isError: boolean, title: string, sub: string, buttons: readonly { label: string; run: () => unknown }[]): void {
		const alert = dom.append(this.element, $(isError ? '.ppd-alert.ppd-alert-error' : '.ppd-alert'));
		dom.append(alert, $('.ppd-alert-title')).textContent = title;
		dom.append(alert, $('.ppd-alert-sub')).textContent = sub;
		if (buttons.length > 0) {
			const row = dom.append(alert, $('.ppd-actions'));
			for (const button of buttons) {
				this.appendButton(row, button.label, true, button.run);
			}
		}
	}

	private appendButton(parent: HTMLElement, label: string, small: boolean, run: () => unknown): void {
		const button = this.bodyListeners.add(new ParadisButton(parent, { kind: 'secondary', label, small }));
		this.bodyListeners.add(button.onDidClick(() => void run()));
		this.buttons.push(button.element);
	}

	/**
	 * 失うものを数字で見せてから確かめる。
	 *
	 * 「本当によろしいですか」だけでは、押す人は自分が何を失うのか分からない。常駐にした人に
	 * とっては、この数字こそが確かめたいことなので、必ず出す。
	 */
	private async confirm(message: string, primaryButton: string): Promise<boolean> {
		// 確認より先に小窓を閉じる（小窓の段は確認ダイアログより上）
		this.options.onClose();
		const count = this.status.terminalCount;
		// 分からないときに「ありません」と言わない。聞けなかっただけで、抱えていないとは
		// 限らない。**押した結果が取り返しのつかない操作**なので、ここで嘘をつくのが一番まずい。
		const detail = count === undefined
			? localize('paradis.ptyDaemon.confirm.detailUnknown', "動いているターミナルはすべて終了します。何本抱えているかは、いま聞き出せていません。実行中のコマンドやエージェントも一緒に終わり、元には戻せません。")
			: count === 0
				? localize('paradis.ptyDaemon.confirm.detailEmpty', "いま抱えているターミナルはありません。")
				: localize('paradis.ptyDaemon.confirm.detail', "動いている{0}本のターミナルが終了します。実行中のコマンドやエージェントも一緒に終わり、元には戻せません。", count);
		// 接続先では、失うのが自分の作業だけとは限らない。同じサーバーに繋いでいる他の
		// ウィンドウのターミナルも同じ常駐が抱えている。
		const shared = paradisDaemonSharedHostWarning(this.options.scope);
		const { confirmed } = await this.paradisDialogService.confirm({
			destructive: true,
			type: Severity.Warning,
			message,
			detail: shared === undefined ? detail : `${detail}\n${shared}`,
			primaryButton,
		});
		return confirmed;
	}

	private async confirmAndRestart(): Promise<void> {
		if (!await this.confirm(
			paradisDaemonRestartTitle(this.options.scope),
			localize('paradis.ptyDaemon.confirm.restartButton', "再起動"),
		)) {
			return;
		}
		await this.act(() => this.options.service.restart());
	}

	private async confirmAndStop(): Promise<void> {
		if (!await this.confirm(
			paradisDaemonStopTitle(this.options.scope),
			localize('paradis.ptyDaemon.confirm.stopButton', "停止"),
		)) {
			return;
		}
		await this.act(() => this.options.service.stop());
	}

	/**
	 * 古い常駐を止める。**本数を数字で出さない**のは、こちらからは分からないから。
	 * 分からないことを 0 と書くのが一番危ない。
	 */
	private async confirmAndStopForeign(pid: number, buildId: string): Promise<void> {
		this.options.onClose();
		const shared = paradisDaemonSharedHostWarning(this.options.scope);
		const detail = localize('paradis.ptyDaemon.confirm.foreignDetail', "{0} が抱えているターミナルはすべて終了します。何本残っているかは、こちらからは分かりません。", paradisShortBuildId(buildId));
		const { confirmed } = await this.paradisDialogService.confirm({
			destructive: true,
			type: Severity.Warning,
			message: paradisDaemonForeignStopTitle(this.options.scope),
			detail: shared === undefined ? detail : `${detail}\n${shared}`,
			primaryButton: localize('paradis.ptyDaemon.confirm.foreignButton', "停止"),
		});
		if (!confirmed) {
			return;
		}
		await this.act(() => this.options.service.stopForeign(pid));
	}

	/**
	 * 確認の後の操作を実行する。失敗しても黙らない。
	 *
	 * 確認ダイアログを開く前に小窓は閉じている（{@link confirm}）ので、
	 * 失敗は通知で知らせる。成否にかかわらず状態は取り直す（途中まで進んでいることがある）。
	 */
	private async act(run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			this.notificationService.error(localize('paradis.ptyDaemon.actFailed', "常駐ターミナルを操作できませんでした: {0}", toErrorMessage(error)));
		} finally {
			this.options.onDidAct();
		}
	}
}
