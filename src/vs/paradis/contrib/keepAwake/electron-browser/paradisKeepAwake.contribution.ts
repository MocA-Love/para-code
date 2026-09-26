/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize, localize2 } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, NeverShowAgainScope } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IPowerService } from '../../../../workbench/services/power/common/powerService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { PARADIS_KEEP_AWAKE_PROMPT_COMMAND, PARADIS_KEEP_AWAKE_SELECT_COMMAND, PARADIS_KEEP_AWAKE_SETTING, ParadisKeepAwakeBlockerMode, ParadisKeepAwakeMode, paradisAgentsActiveAfterSnapshotFailure, paradisAgentsNeedKeepAwake, toParadisKeepAwakeMode } from '../common/paradisKeepAwake.js';
import { IParadisAgentStatusSnapshotService } from '../../agentBrowser/electron-browser/paradisAgentStatusSnapshotService.js';
import { ParadisKeepAwakeController } from '../common/paradisKeepAwakeController.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

const STATUSBAR_ENTRY_ID = 'paradis.power.keepAwake';

/**
 * `paradis.power.keepAwake` 設定に従い、Electron の powerSaveBlocker（`IPowerService` 経由）で
 * PC のスリープを防止する contribution。
 *
 * powerSaveBlocker はアプリ全体にスタックする方式（発行された全 id が stop されるまで有効）のため、
 * 各ウィンドウの controller が成功済み blocker id を所有し、「Para Code のウィンドウがどれか1枚でも
 * 開いていれば有効・全部閉じたら解除」という意味論になる。ウィンドウが正常に閉じずに stop が
 * 飛ばなかった場合でも、blocker はプロセス（electron-main）終了と共に消えるためリークは
 * アプリ生存中に限られる。
 *
 * 有効中はステータスバーにインジケーターを表示し、クリックでモード選択の Quick Pick を開く
 * （「なぜ PC が眠らないのか」をユーザーが見失わないための安全装置）。
 *
 * `auto` モードでは、このウィンドウのペインのエージェント状態（hook / transcript 由来。
 * {@link IParadisAgentStatusSnapshotService} が約2秒ごとに配る）を見て、作業中・許可待ち・質問中の
 * ペインがある間だけ 'system' の blocker を掛ける。スナップショットの取得に失敗した回は直前の判断を保つが、
 * 約60秒続けて取れなければ「動いていない」に倒す。
 */
export class ParadisKeepAwakeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisKeepAwake';

	private readonly statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly controller: ParadisKeepAwakeController;
	private readonly agentStatusSubscription = this._register(new MutableDisposable());
	/** auto モードで直近に判断した「エージェントが動いているか」。 */
	private agentsActive = false;
	/** auto モードで最後にスナップショットが取れた時刻（購読を張った時刻から数え始める）。 */
	private lastSnapshotAt = 0;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPowerService private readonly powerService: IPowerService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILogService private readonly logService: ILogService,
		@IParadisAgentStatusSnapshotService private readonly agentStatusSnapshotService: IParadisAgentStatusSnapshotService,
	) {
		super();

		this.controller = this._register(new ParadisKeepAwakeController({
			start: mode => this.powerService.startPowerSaveBlocker(
				mode === 'display' ? 'prevent-display-sleep' : 'prevent-app-suspension'
			),
			stop: async id => {
				const stopped = await this.powerService.stopPowerSaveBlocker(id);
				if (!stopped) {
					throw new Error('Power save blocker could not be stopped');
				}
			},
			onDidChangeMode: () => this.updateStatusbar(),
			report: (operation, error) => {
				reportParadisDiagnosticError('owned', 'keep-awake', operation, error, undefined, 'warning');
				this.logService.error('[paradisKeepAwake] ' + operation, error);
			},
		}));
		this.applyMode();

		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_KEEP_AWAKE_SETTING)) {
				this.applyMode();
			}
		}));
	}

	private getMode(): ParadisKeepAwakeMode {
		return toParadisKeepAwakeMode(this.configurationService.getValue(PARADIS_KEEP_AWAKE_SETTING));
	}

	/** 設定のモードに合わせて、エージェント状態の購読を張る/外し、blocker を反映する。 */
	private applyMode(): void {
		if (this.getMode() === 'auto') {
			if (!this.agentStatusSubscription.value) {
				this.agentsActive = false;
				this.lastSnapshotAt = Date.now();
				// subscribe は最新のスナップショットをその場で配ることがあるので、コールバックからは
				// 購読の張り直しを伴わない applyBlocker だけを呼ぶ。
				this.agentStatusSubscription.value = this.agentStatusSnapshotService.subscribe(outcome => {
					const now = Date.now();
					let active: boolean;
					if (outcome.snapshot) {
						this.lastSnapshotAt = now;
						active = paradisAgentsNeedKeepAwake(outcome.snapshot.paneStatuses, now);
					} else {
						active = paradisAgentsActiveAfterSnapshotFailure(this.agentsActive, this.lastSnapshotAt, now);
						if (active !== this.agentsActive) {
							this.logService.info('[paradisKeepAwake] agent status has been unavailable for a while; letting the PC sleep');
						}
					}
					if (active !== this.agentsActive) {
						this.agentsActive = active;
						this.applyBlocker();
					}
				});
			}
		} else {
			this.agentStatusSubscription.clear();
			this.agentsActive = false;
		}
		this.applyBlocker();
	}

	/** 設定のモードと（auto なら）エージェント状態から、実際に掛ける blocker を決めて反映する。 */
	private applyBlocker(): void {
		const mode = this.getMode();
		const blockerMode: ParadisKeepAwakeBlockerMode = mode === 'auto' ? (this.agentsActive ? 'system' : 'off') : mode;
		// auto と system は同じ blocker なので actualMode が変わらず onDidChangeMode が来ない。
		// 表示名だけは変わるので、反映後に必ず表示を更新する。
		const update = () => this.updateStatusbar();
		void this.controller.setMode(blockerMode).then(update, update);
	}

	private updateStatusbar(): void {
		if (this._store.isDisposed) {
			return;
		}

		const mode = this.controller.actualMode;
		if (mode === 'off') {
			this.statusbarEntry.clear();
			return;
		}

		const auto = this.getMode() === 'auto';
		const label = mode === 'display'
			? localize('paradis.keepAwake.statusbar.display', "スリープ防止中（画面）")
			: auto
				? localize('paradis.keepAwake.statusbar.auto', "スリープ防止中（エージェント）")
				: localize('paradis.keepAwake.statusbar.system', "スリープ防止中");
		const entry = {
			name: localize('paradis.keepAwake.statusbar.name', "スリープ防止"),
			text: `$(zap) ${label}`,
			ariaLabel: label,
			tooltip: mode === 'display'
				? localize('paradis.keepAwake.statusbar.tooltip.display', "画面スリープと自動ロックを防止しています。クリックでモードを変更します。")
				: auto
					? localize('paradis.keepAwake.statusbar.tooltip.auto', "エージェントが作業中・許可待ち・質問中のため、システムスリープを防止しています（同じ状態が 2 時間続くと解除）。クリックでモードを変更します。")
					: localize('paradis.keepAwake.statusbar.tooltip.system', "システムスリープを防止しています（画面の消灯・ロックは通常どおり）。クリックでモードを変更します。"),
			command: PARADIS_KEEP_AWAKE_SELECT_COMMAND
		};

		if (this.statusbarEntry.value) {
			this.statusbarEntry.value.update(entry);
		} else {
			this.statusbarEntry.value = this.statusbarService.addEntry(entry, STATUSBAR_ENTRY_ID, StatusbarAlignment.RIGHT, 48);
		}
	}
}

registerWorkbenchContribution2(ParadisKeepAwakeContribution.ID, ParadisKeepAwakeContribution, WorkbenchPhase.AfterRestored);

/** モード選択の Quick Pick（ステータスバーのクリック先、コマンドパレットからも実行可）。 */
class ParadisSelectKeepAwakeModeAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_KEEP_AWAKE_SELECT_COMMAND,
			title: localize2('paradis.power.selectKeepAwakeMode', "Select Keep Awake Mode (Sleep Prevention)"),
			category: localize2('paradis.category', "Para Code"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);

		const current = toParadisKeepAwakeMode(configurationService.getValue(PARADIS_KEEP_AWAKE_SETTING));
		interface IModeItem extends IQuickPickItem { mode: ParadisKeepAwakeMode }
		const items: IModeItem[] = [
			{
				mode: 'off',
				label: localize('paradis.keepAwake.pick.off', "オフ"),
				description: localize('paradis.keepAwake.pick.off.description', "スリープを防止しない")
			},
			{
				mode: 'auto',
				label: localize('paradis.keepAwake.pick.auto', "エージェントの作業中だけ防止"),
				description: localize('paradis.keepAwake.pick.auto.description', "作業中・許可待ち・質問中のあいだだけシステムスリープを防止（同じ状態が 2 時間続くと解除）")
			},
			{
				mode: 'system',
				label: localize('paradis.keepAwake.pick.system', "常にシステムスリープを防止"),
				description: localize('paradis.keepAwake.pick.system.description', "画面は消灯・ロックしてよい。プロセスは動き続ける（遠隔操作向けの推奨）")
			},
			{
				mode: 'display',
				label: localize('paradis.keepAwake.pick.display', "常に画面スリープも防止"),
				description: localize('paradis.keepAwake.pick.display.description', "画面が消灯せず、無操作の自動ロックも発動しない")
			}
		];
		const currentItem = items.find(item => item.mode === current);
		if (currentItem) {
			currentItem.description = `${currentItem.description} ✓`;
		}

		const picked = await quickInputService.pick(items, {
			placeHolder: localize('paradis.keepAwake.pick.placeholder', "PC をスリープさせない範囲を選択してください（現在: {0}）", currentItem?.label ?? current),
			activeItem: currentItem
		});
		if (picked) {
			await configurationService.updateValue(PARADIS_KEEP_AWAKE_SETTING, picked.mode, ConfigurationTarget.USER);
		}
	}
}
registerAction2(ParadisSelectKeepAwakeModeAction);

// モバイルデバイス接続時などリモート作業の開始点から呼ばれることを想定した内部コマンド（コマンドパレット非表示）。
// 設定が 'off' の場合のみ、スリープ防止を有効にするよう推奨する。「今後表示しない」は
// アプリケーションスコープで永続化される。現時点ではどこからも呼び出されていない。
CommandsRegistry.registerCommand(PARADIS_KEEP_AWAKE_PROMPT_COMMAND, (accessor: ServicesAccessor) => {
	const configurationService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);

	if (toParadisKeepAwakeMode(configurationService.getValue(PARADIS_KEEP_AWAKE_SETTING)) !== 'off') {
		return;
	}

	notificationService.prompt(
		Severity.Info,
		localize('paradis.keepAwake.recommend', "モバイルデバイスから接続中です。PC がスリープすると接続が切れて作業を続行できなくなります。スリープ防止を有効にしますか？（画面の消灯・ロックは通常どおり行われます）"),
		[
			{
				label: localize('paradis.keepAwake.recommend.enable', "有効にする"),
				run: () => configurationService.updateValue(PARADIS_KEEP_AWAKE_SETTING, 'system', ConfigurationTarget.USER)
			},
			{
				label: localize('paradis.keepAwake.recommend.notNow', "今回はしない"),
				run: () => { }
			}
		],
		{
			neverShowAgain: { id: 'paradis.power.keepAwakeRecommendation', scope: NeverShowAgainScope.APPLICATION }
		}
	);
});
