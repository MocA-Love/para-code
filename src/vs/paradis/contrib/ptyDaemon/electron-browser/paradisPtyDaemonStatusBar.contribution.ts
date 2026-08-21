/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルのステータスバー項目。
//
// 出し方は、モックを見て決めた「案A」。**平常時はアイコンと数字だけで、色も言葉も持たせない**。
// 常駐しているのは異常ではなく既定の状態なので、普通に見えるべきという立場を取る。ステータス
// バーは既に混んでいるので、平常時に幅を取らないことも兼ねている。
//
// 色が付くのは2つの場合だけ。
//  - 古いビルドの常駐が残っている (放っておくと見えないところでメモリを抱え続ける)
//  - 設定は有効なのに常駐へ繋がっていない (次に閉じたらターミナルが消える)
//
// 設定が無効なら**何も出さない**。使っていない機能の痕跡をステータスバーに残さない。

import * as dom from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import {
	IParadisPtyDaemonStatus,
	IParadisPtyDaemonStatusService,
	PARADIS_PTY_DAEMON_CHANNEL,
	paradisDaemonSeverity,
} from '../common/paradisPtyDaemonStatus.js';
import { PARADIS_PTY_DAEMON_ENABLED } from '../common/paradisPtyDaemonSettingKey.js';
import { ParadisPtyDaemonPopover } from './paradisPtyDaemonPopover.js';

const ENTRY_ID = 'paradis.ptyDaemon';
const TOGGLE_COMMAND = 'paradis.ptyDaemon.showDetails';

/** 平常時の見に行く間隔。数字が動くのは本数が変わったときだけなので、細かく刻む意味は無い。 */
const IDLE_REFRESH = 30_000;

/** 詳細を開いている間の間隔。押した結果がその場で見えてほしい。 */
const OPEN_REFRESH = 3_000;

/**
 * 状態の返事を待つ上限。
 *
 * 上限が要るのは相手が遅いからではなく、**解決しない待ちが一度でも生まれると画面が二度と
 * 動かなくなる**から。開いている間の更新は前の問い合わせが終わってから次を積むので、
 * 待ちが解けなければ次が積まれない。実際にそれが起き、パネルが最初の一瞬の値のまま
 * 何時間も凍った (原因は `paradisPtyDaemonControlClient.ts` の冒頭)。
 */
const STATUS_TIMEOUT = 5_000;

class ParadisPtyDaemonStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.ptyDaemonStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly popover = this._register(new MutableDisposable<ParadisPtyDaemonPopover>());
	private readonly service: IParadisPtyDaemonStatusService;
	private status: IParadisPtyDaemonStatus | undefined;
	private timer: Timeout | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();

		this.service = ProxyChannel.toService<IParadisPtyDaemonStatusService>(mainProcessService.getChannel(PARADIS_PTY_DAEMON_CHANNEL));

		this._register(CommandsRegistry.registerCommand(TOGGLE_COMMAND, () => this.togglePopover()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_PTY_DAEMON_ENABLED)) {
				void this.refresh();
			}
		}));
		this._register(dom.disposableWindowInterval(dom.getActiveWindow(), () => void this.refresh(), IDLE_REFRESH));

		void this.refresh();
	}

	override dispose(): void {
		this.clearTimer();
		super.dispose();
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private async refresh(): Promise<void> {
		let status: IParadisPtyDaemonStatus | undefined;
		try {
			status = await raceTimeout(this.service.getStatus(), STATUS_TIMEOUT);
		} catch {
			// main と話せないのは、まだ立ち上がっていないときか、閉じている最中。次の周期で拾う。
			return;
		}
		if (this._store.isDisposed) {
			return;
		}
		if (!status) {
			// 返事が来なかった。前の値は出したまま次の周期でもう一度聞くが、**本数だけは
			// 分からないものへ倒す**。聞けていないのに古い数字を残すと、停止の確認が
			// 「いま抱えているターミナルはありません。」と断言したまま押させ得る。
			this.forgetTerminalCount();
			return;
		}
		this.status = status;
		this.renderEntry(status);
		this.popover.value?.update(status);
	}

	/**
	 * 本数を「分からない」へ倒す。数える手段を失っただけで、抱えていないとは限らない。
	 */
	private forgetTerminalCount(): void {
		if (!this.status || this.status.terminalCount === undefined) {
			return;
		}
		this.status = { ...this.status, terminalCount: undefined, spaces: [] };
		this.renderEntry(this.status);
		this.popover.value?.update(this.status);
	}

	private renderEntry(status: IParadisPtyDaemonStatus): void {
		if (!status.enabled) {
			// 使っていない機能の痕跡を残さない。開いたままの詳細も閉じる（項目が消えるので、
			// 残すと寄り添う先を失って画面の隅へ飛ぶ）。
			this.closePopover();
			this.entry.clear();
			return;
		}

		const severity = paradisDaemonSeverity(status);
		// 本数が分からないときに 0 と出さない。聞けなかっただけで、抱えていないとは限らない。
		const count = status.terminalCount === undefined ? '?' : String(status.terminalCount);
		const text = status.running
			? `$(server-process) ${count}`
			: `$(debug-disconnect) !`;

		const properties: IStatusbarEntry = {
			name: localize('paradis.ptyDaemon.status.name', "常駐ターミナル"),
			text: severity === 'warn' ? `${text} $(warning)` : text,
			ariaLabel: !status.running
				? localize('paradis.ptyDaemon.status.ariaStopped', "常駐ターミナルは停止しています")
				: status.terminalCount === undefined
					? localize('paradis.ptyDaemon.status.ariaUnknown', "常駐ターミナルの本数を取得できていません")
					: localize('paradis.ptyDaemon.status.aria', "常駐ターミナル {0}本", status.terminalCount),
			tooltip: !status.running
				? localize('paradis.ptyDaemon.status.tooltipStopped', "常駐が動いていません。いまのターミナルは Para Code の中で動いています。クリックで詳細。")
				: status.terminalCount === undefined
					? localize('paradis.ptyDaemon.status.tooltipUnknown', "常駐は動いていますが、いま何を抱えているかを聞き出せていません。クリックで詳細。")
					: localize('paradis.ptyDaemon.status.tooltip', "{0}本のターミナルを、Para Code の外の常駐が抱えています。クリックで詳細。", status.terminalCount),
			command: TOGGLE_COMMAND,
			kind: severity === 'error' ? 'error' : undefined,
		};

		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			this.entry.value = this.statusbarService.addEntry(properties, ENTRY_ID, StatusbarAlignment.RIGHT, -9991);
		}
	}

	/**
	 * ステータスバーの項目の DOM を探す。
	 *
	 * `addEntry` は要素を返さないが、`statusbarPart.ts` は項目の `id` をそのまま DOM の `id` に
	 * するので、そこから辿れる。`querySelector` にドット入りの id を渡すとエスケープが要るので、
	 * 属性で突き合わせる。
	 */
	private findAnchor(): HTMLElement | undefined {
		// eslint-disable-next-line no-restricted-syntax -- 既存のステータスバー項目を読むだけで、要素の構築ではない
		const items = this.layoutService.activeContainer.querySelectorAll('.statusbar-item');
		for (const item of items) {
			if (item.id === ENTRY_ID) {
				return item as HTMLElement;
			}
		}
		return undefined;
	}

	private togglePopover(): void {
		if (this.popover.value) {
			this.closePopover();
			return;
		}
		const anchor = this.findAnchor();
		if (!anchor || !this.status) {
			return;
		}
		this.popover.value = this.instantiationService.createInstance(ParadisPtyDaemonPopover, anchor, {
			status: this.status,
			service: this.service,
			onClose: () => this.closePopover(),
			onDidAct: () => void this.refresh(),
		});
		this.scheduleOpenRefresh();
	}

	/** 開いている間だけ短い間隔で見に行く。閉じたら止める。 */
	private scheduleOpenRefresh(): void {
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.popover.value) {
				return;
			}
			// 前の問い合わせが終わってから次を積む。待たずに積むと、常駐の返事が遅いときに
			// 更新同士が重なる。
			void this.refresh().finally(() => {
				if (this.popover.value) {
					this.scheduleOpenRefresh();
				}
			});
		}, OPEN_REFRESH);
	}

	private closePopover(): void {
		this.clearTimer();
		this.popover.clear();
	}
}

registerWorkbenchContribution2(ParadisPtyDaemonStatusBarContribution.ID, ParadisPtyDaemonStatusBarContribution, WorkbenchPhase.AfterRestored);
