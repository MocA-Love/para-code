/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の状態を確かめて見せるコマンド（設定画面の「状態を確認…」から呼ぶ）。
//
// 補助アプリの状態（設計書 5.3）と、OS の許可（アクセシビリティ・画面収録）が補助アプリに付いているかを出す。
// 許可は Para Code 本体ではなく「Para Code Computer Use」に付ける、と必ず書く（本体に付けると、ターミナルの
// 全プロセスが同じ許可を使えてしまい、アプリごとの承認を素通りできる。設計書 4 章）。
// 許可したアプリの一覧と取り消し、OS の許可のやり直しは後の段（設計書 7 章 S4）で足す。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisComputerUseStatus,
	PARADIS_COMPUTER_USE_REFRESH_METHOD,
	PARADIS_COMPUTER_USE_SHOW_STATUS_COMMAND_ID,
	PARADIS_COMPUTER_USE_STATUS_CHANNEL,
	ParadisComputerUseAvailability,
	paradisParseComputerUseStatus,
} from '../common/paradisComputerUse.js';

/** 状態を利用者向けの 1 文にする。 */
export function paradisComputerUseAvailabilityText(availability: ParadisComputerUseAvailability, enabled: boolean): string {
	switch (availability) {
		case 'unsupported-os':
			return localize('paradis.computerUse.status.unsupported', "macOS 14 以降で使えます。");
		case 'missing':
			return localize('paradis.computerUse.status.missing', "このビルドには Computer Use の部品が含まれていません。");
		case 'launch-failed':
			return localize('paradis.computerUse.status.launchFailed', "Computer Use の部品を起動できませんでした。");
		case 'incompatible':
			return localize('paradis.computerUse.status.incompatible', "部品の版が合いません。Para Code を入れ直してください。");
		case 'misattributed':
			return localize('paradis.computerUse.status.misattributed', "この Mac では許可を Para Code 本体と分けられないため使えません。");
		case 'ok':
			return localize('paradis.computerUse.status.ok', "使える状態です。");
		case 'unchecked':
		default:
			return enabled
				? localize('paradis.computerUse.status.checking', "確かめています。")
				: localize('paradis.computerUse.status.off', "オフです。設定の「Computer Use を使う」をオンにすると使えます。");
	}
}

function permissionLine(label: string, granted: boolean): string {
	return granted
		? localize('paradis.computerUse.status.granted', "{0}: 許可済み", label)
		: localize('paradis.computerUse.status.notGranted', "{0}: 未許可", label);
}

class ParadisShowComputerUseStatusAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_COMPUTER_USE_SHOW_STATUS_COMMAND_ID,
			title: localize2('paradis.computerUse.showStatus', "Computer Use の状態を確認"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const channel = accessor.get(ISharedProcessService).getChannel(PARADIS_COMPUTER_USE_STATUS_CHANNEL);
		const dialogService = accessor.get(IDialogService);
		const logService = accessor.get(ILogService);
		let status: IParadisComputerUseStatus | undefined;
		try {
			status = paradisParseComputerUseStatus(await channel.call<unknown>(PARADIS_COMPUTER_USE_REFRESH_METHOD));
		} catch (error) {
			logService.warn('[ParadisComputerUse] could not read the status', error);
		}
		if (!status) {
			await dialogService.info(localize('paradis.computerUse.status.title', "Computer Use"), localize('paradis.computerUse.status.unreadable', "状態を読めませんでした。"));
			return;
		}
		if (status.detail) {
			logService.info(`[ParadisComputerUse] ${status.availability}: ${status.detail}`);
		}
		const lines = [paradisComputerUseAvailabilityText(status.availability, status.enabled)];
		if (status.availability === 'ok' && status.permissions) {
			lines.push(
				permissionLine(localize('paradis.computerUse.status.accessibility', "アクセシビリティ"), status.permissions.accessibility),
				permissionLine(localize('paradis.computerUse.status.screenRecording', "画面収録"), status.permissions.screenRecording),
			);
			if (!status.permissions.accessibility || !status.permissions.screenRecording) {
				lines.push(localize('paradis.computerUse.status.howToGrant', "許可は「システム設定」→「プライバシーとセキュリティ」で「Para Code Computer Use」に付けてください。Para Code 本体には付けないでください。"));
			}
		}
		await dialogService.info(localize('paradis.computerUse.status.title', "Computer Use"), lines.join('\n'));
	}
}

registerAction2(ParadisShowComputerUseStatusAction);
