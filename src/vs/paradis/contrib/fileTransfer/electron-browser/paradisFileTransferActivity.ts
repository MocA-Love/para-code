/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アクティビティバーの左下（アカウントと設定の間）の「ファイル転送」のボタン（主の入口）。
//
// 見た目と操作はアクティビティバーの他の項目と同じ部品（CompositeBarActionViewItem）に任せ、
// 押すとタブを開く。転送中は件数のバッジ（upstream の NumberBadge）を出し、ホバーに全体の進み具合を
// 添える。タブが前面にある間は、ビューの入れ物と同じ「左の線と背景」で開いていることを示す。

import { IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { CompositeBarAction, CompositeBarActionViewItem, ICompositeBarActionViewItemOptions } from '../../../../workbench/browser/parts/compositeBarActions.js';
import { NumberBadge } from '../../../../workbench/services/activity/common/activity.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { PARADIS_FILE_TRANSFER_ACTIVITY_ID, PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID } from '../common/paradisFileTransfer.js';
import { registerParadisGlobalActivityEntry } from '../../../browser/paradisGlobalActivitySlot.js';
import { PARADIS_FILE_TRANSFER_ICON, ParadisFileTransferInput } from './paradisFileTransferInput.js';
import { paradisQueueSummaryText } from './paradisFileTransferQueueView.js';
import { IParadisFileTransferService } from './paradisFileTransferService.js';

/** 押すとタブを開く。ActionBar はこの Action の run を呼ぶ（マウス・Enter・タップのどれでも）。 */
class ParadisFileTransferActivityAction extends CompositeBarAction {

	constructor(private readonly commandService: ICommandService) {
		super({
			id: PARADIS_FILE_TRANSFER_ACTIVITY_ID,
			name: localize('paradis.fileTransfer.activityName', "ファイル転送"),
			classNames: ThemeIcon.asClassNameArray(PARADIS_FILE_TRANSFER_ICON),
			keybindingId: PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID,
		});
	}

	override async run(): Promise<void> {
		await this.commandService.executeCommand(PARADIS_FILE_TRANSFER_OPEN_COMMAND_ID);
	}
}

export class ParadisFileTransferActivityViewItem extends CompositeBarActionViewItem {

	constructor(
		options: ICompositeBarActionViewItemOptions,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService commandService: ICommandService,
		@IParadisFileTransferService private readonly transferService: IParadisFileTransferService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		const action = new ParadisFileTransferActivityAction(commandService);
		super(action, { draggable: false, ...options, icon: true }, () => true, themeService, hoverService, configurationService, keybindingService);
		this._register(action);
		this._register(transferService.queue.onDidChange(() => this.updateBadge()));
		this._register(editorService.onDidActiveEditorChange(() => this.updateActive()));
		this.updateBadge();
		this.updateActive();
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('para-ft-activity');
		this.updateChecked();
	}

	private updateBadge(): void {
		const action = this._action as CompositeBarAction;
		const active = this.transferService.queue.getSummary().active;
		const previous = action.activities[0]?.badge;
		if (active === 0) {
			if (action.activities.length) {
				action.activities = [];
			}
			return;
		}
		// 件数が同じ間は描き直さない（進み具合の通知は秒に数回来る）。ホバーの文はホバーした時点で作る
		if (previous instanceof NumberBadge && previous.number === active) {
			return;
		}
		action.activities = [{ badge: new NumberBadge(active, () => paradisQueueSummaryText(this.transferService.queue)) }];
	}

	private updateActive(): void {
		const action = this._action as CompositeBarAction;
		if (this.editorService.activeEditor instanceof ParadisFileTransferInput) {
			action.activate();
		} else {
			action.deactivate();
		}
	}

	protected override updateChecked(): void {
		if (!this.container) {
			return;
		}
		this.container.classList.toggle('checked', this._action.checked === true);
		this.container.setAttribute('aria-pressed', String(this._action.checked === true));
		this.updateStyles();
	}
}

function isCompositeBarOptions(options: IActionViewItemOptions): options is ICompositeBarActionViewItemOptions {
	const candidate = options as Partial<ICompositeBarActionViewItemOptions>;
	return typeof candidate.colors === 'function' && typeof candidate.hoverOptions?.position === 'function';
}

// アクティビティバーが作られる前（この集約 import の読み込み時）に登録する
registerParadisGlobalActivityEntry({
	id: PARADIS_FILE_TRANSFER_ACTIVITY_ID,
	createViewItem: (instantiationService, options) => {
		// 差し込み口は workbench の型を持たないので、アクティビティバーの部品の options かを確かめてから使う
		if (!isCompositeBarOptions(options)) {
			throw new Error('paradis.fileTransfer: unexpected global activity options');
		}
		return instantiationService.createInstance(ParadisFileTransferActivityViewItem, options);
	},
});
