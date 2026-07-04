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
import { IPowerService, PowerSaveBlockerType } from '../../../../workbench/services/power/common/powerService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { PARADIS_KEEP_AWAKE_PROMPT_COMMAND, PARADIS_KEEP_AWAKE_SELECT_COMMAND, PARADIS_KEEP_AWAKE_SETTING, ParadisKeepAwakeMode, toParadisKeepAwakeMode } from '../common/paradisKeepAwake.js';

const STATUSBAR_ENTRY_ID = 'paradis.power.keepAwake';

/**
 * `paradis.power.keepAwake` 設定に従い、Electron の powerSaveBlocker（`IPowerService` 経由）で
 * PC のスリープを防止する contribution。
 *
 * powerSaveBlocker はアプリ全体にスタックする方式（発行された全 id が stop されるまで有効）のため、
 * 各ウィンドウのこの contribution が自分の blocker id を1つずつ持てば、「Para Code のウィンドウが
 * どれか1枚でも開いていれば有効・全部閉じたら解除」という意味論になる。ウィンドウが正常に閉じずに
 * stop が飛ばなかった場合でも、blocker はプロセス（electron-main）終了と共に消えるためリークは
 * アプリ生存中に限られる。
 *
 * 有効中はステータスバーにインジケーターを表示し、クリックでモード選択の Quick Pick を開く
 * （「なぜ PC が眠らないのか」をユーザーが見失わないための安全装置）。
 */
class ParadisKeepAwakeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisKeepAwake';

	/** 現在この ウィンドウが保持している blocker id（未保持は undefined）。 */
	private blockerId: number | undefined;

	/** 非同期の start/stop が交錯したとき、最後の update だけを勝たせるための世代カウンタ。 */
	private generation = 0;

	private readonly statusbarEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPowerService private readonly powerService: IPowerService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.update();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_KEEP_AWAKE_SETTING)) {
				this.update();
			}
		}));
	}

	private getMode(): ParadisKeepAwakeMode {
		return toParadisKeepAwakeMode(this.configurationService.getValue(PARADIS_KEEP_AWAKE_SETTING));
	}

	private async update(): Promise<void> {
		const generation = ++this.generation;
		const mode = this.getMode();
		const type: PowerSaveBlockerType | undefined =
			mode === 'system' ? 'prevent-app-suspension' :
				mode === 'display' ? 'prevent-display-sleep' :
					undefined;

		try {
			// 先に新しい blocker を張ってから古いものを外す（モード切替時に一瞬もスリープ可能に
			// ならないようにする。blocker はスタックするので二重期間があっても問題ない）。
			let newId: number | undefined;
			if (type !== undefined) {
				newId = await this.powerService.startPowerSaveBlocker(type);
			}

			if (generation !== this.generation || this._store.isDisposed) {
				// この update 中に設定が再変更された/ウィンドウが閉じた。今張った blocker は即座に返上する。
				if (newId !== undefined) {
					this.powerService.stopPowerSaveBlocker(newId).catch(error => this.logService.error('[paradisKeepAwake] failed to stop superseded power save blocker', error));
				}
				return;
			}

			const oldId = this.blockerId;
			this.blockerId = newId;
			if (oldId !== undefined) {
				await this.powerService.stopPowerSaveBlocker(oldId);
			}
		} catch (error) {
			this.logService.error('[paradisKeepAwake] failed to update power save blocker', error);
		}

		if (generation === this.generation && !this._store.isDisposed) {
			this.updateStatusbar(mode);
		}
	}

	private updateStatusbar(mode: ParadisKeepAwakeMode): void {
		if (mode === 'off') {
			this.statusbarEntry.clear();
			return;
		}

		const label = mode === 'display'
			? localize('paradis.keepAwake.statusbar.display', "スリープ防止中（画面）")
			: localize('paradis.keepAwake.statusbar.system', "スリープ防止中");
		const entry = {
			name: localize('paradis.keepAwake.statusbar.name', "スリープ防止"),
			text: `$(zap) ${label}`,
			ariaLabel: label,
			tooltip: mode === 'display'
				? localize('paradis.keepAwake.statusbar.tooltip.display', "画面スリープと自動ロックを防止しています。クリックでモードを変更します。")
				: localize('paradis.keepAwake.statusbar.tooltip.system', "システムスリープを防止しています（画面の消灯・ロックは通常どおり）。クリックでモードを変更します。"),
			command: PARADIS_KEEP_AWAKE_SELECT_COMMAND
		};

		if (this.statusbarEntry.value) {
			this.statusbarEntry.value.update(entry);
		} else {
			this.statusbarEntry.value = this.statusbarService.addEntry(entry, STATUSBAR_ENTRY_ID, StatusbarAlignment.RIGHT, 48);
		}
	}

	override dispose(): void {
		// dispose は同期なので await できない。stop の完了は待たず投げっぱなしにする
		// （届かなかった場合も electron-main プロセス終了時に blocker は消える）。
		this.generation++;
		if (this.blockerId !== undefined) {
			this.powerService.stopPowerSaveBlocker(this.blockerId).catch(error => this.logService.error('[paradisKeepAwake] failed to stop power save blocker on dispose', error));
			this.blockerId = undefined;
		}
		super.dispose();
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
				mode: 'system',
				label: localize('paradis.keepAwake.pick.system', "システムスリープを防止"),
				description: localize('paradis.keepAwake.pick.system.description', "画面は消灯・ロックしてよい。プロセスは動き続ける（遠隔操作向けの推奨）")
			},
			{
				mode: 'display',
				label: localize('paradis.keepAwake.pick.display', "画面スリープも防止"),
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

// モバイルデバイス接続時などリモート作業の開始点から呼ばれる内部コマンド（コマンドパレット非表示）。
// 設定が 'off' の場合のみ、スリープ防止を有効にするよう推奨する。「今後表示しない」は
// アプリケーションスコープで永続化される。
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
