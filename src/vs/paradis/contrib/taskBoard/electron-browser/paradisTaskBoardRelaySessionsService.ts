/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の窓の中継のセッション（common/paradisTaskBoardRelaySessions.ts）を、窓のサービスにつないで 1 つだけ置く。
// 入口のボタン（セッションを作る）と、接続口からの振り分け（依頼を受ける）の両方から使う。中継はコマンドに登録しない
// （拡張機能の executeCommand から呼べないように）。

import { isEqual } from '../../../../base/common/resources.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import Severity from '../../../../base/common/severity.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { PARADIS_TASK_BOARD_BRIDGE_CHANNEL } from '../common/paradisTaskBoardBridge.js';
import { paradisTaskBoardCommandPreview } from '../common/paradisTaskBoardDisplayText.js';
import { PARADIS_TASK_BOARD_REMOTE_CHANNEL } from '../common/paradisTaskBoardRemote.js';
import { IParadisTaskBoardRelayApproval, IParadisTaskBoardRelayCommandConfirmation, IParadisTaskBoardRelayRecord, PARADIS_TASK_BOARD_RELAY_CONFIRM_TIMEOUT_MS, ParadisTaskBoardRelaySessions } from '../common/paradisTaskBoardRelaySessions.js';

export const IParadisTaskBoardRelaySessionsService = createDecorator<IParadisTaskBoardRelaySessionsService>('paradisTaskBoardRelaySessionsService');

export interface IParadisTaskBoardRelaySessionsService extends Pick<ParadisTaskBoardRelaySessions, 'prepare' | 'bind' | 'close' | 'handle' | 'launchTarget'> {
	readonly _serviceBrand: undefined;
}

/** 工程のコマンドの承認（リポジトリ・フロー・工程ごと）。接続先のリポジトリには書かない。 */
const APPROVAL_STORAGE_KEY = 'paradis.taskBoard.relayCommandApprovals';
const MAX_APPROVALS = 500;

/**
 * 工程のコマンドを、この窓のダイアログで確かめる（設計書 G5・G7）。既定のボタンは「実行しない」。
 *
 * - native のダイアログは長い本文を途中で切り、空行を挟んで後ろに隠した行が見えないことがあるので、使わない。Para Code の
 *   ダイアログ（custom）で、行番号を付けた全文を出す（番号で、空行の後ろに続く行も見える）
 * - 行の数・文字数・hash の先頭を必ず添える
 * - 見えない・別の文字に見える文字を含む本文は、窓と REH がその前に断っている（paradisTaskBoardDisplayText.ts）
 * - 出どころ・フロー・工程の名前はボードからの申告として見せる
 * - 10 分答えが無ければ「実行しない」にしてダイアログを閉じる。閉じきれずに後から押されても実行せず、通知で知らせる
 */
async function confirmCommand(dialogService: IDialogService, notificationService: INotificationService, request: IParadisTaskBoardRelayCommandConfirmation): Promise<'once' | 'remember' | 'deny'> {
	const preview = paradisTaskBoardCommandPreview(request.command, request.hash);
	const source = request.step.source === 'team'
		// allow-any-unicode-next-line
		? localize('paradis.taskBoard.relay.sourceTeam', "チームのフロー（.para-code/paracode.json）")
		: request.step.source === 'personal'
			// allow-any-unicode-next-line
			? localize('paradis.taskBoard.relay.sourcePersonal', "個人のフロー（.para-code/<login>/workflows.json）")
			// allow-any-unicode-next-line
			: localize('paradis.taskBoard.relay.sourceDefault', "既定のフロー（実行するのはリポジトリの中のファイルです）");
	const detail = [
		// allow-any-unicode-next-line
		localize('paradis.taskBoard.relay.confirmWhere', "接続先: {0}\nリポジトリ: {1}\n作業場所: {2}", request.authority, request.repository, request.place),
		// allow-any-unicode-next-line
		localize('paradis.taskBoard.relay.confirmStep', "ボードからの申告: フロー「{0}」（{1}）の工程「{2}」", request.step.flowName, source, request.step.stepName),
		// allow-any-unicode-next-line
		localize('paradis.taskBoard.relay.confirmSize', "コマンド: {0} 行・{1} 文字・SHA-256 {2}…（下に行番号を付けて全文を出しています。最後の行まで確かめてください）", preview.lines, preview.characters, preview.hashPrefix),
		// allow-any-unicode-next-line
		localize('paradis.taskBoard.relay.confirmNote', "コマンドはこの利用者の権限で接続先で動きます。承認しても、コマンドが読むファイル（テストのスクリプトなど）は担当が書き換えられます。10 分たつと、このダイアログで押しても実行しません。"),
	].join('\n\n');
	const markdown = new MarkdownString(undefined, { supportThemeIcons: false, supportHtml: false })
		// allow-any-unicode-next-line
		.appendMarkdown(localize('paradis.taskBoard.relay.confirmCommandHeading', "**実行するコマンド**")).appendCodeblock('text', preview.numbered);
	if (request.previous !== undefined) {
		const previous = paradisTaskBoardCommandPreview(request.previous, '');
		// allow-any-unicode-next-line
		markdown.appendMarkdown(localize('paradis.taskBoard.relay.confirmPreviousHeading', "**前に承認した本文**（{0} 行）", previous.lines)).appendCodeblock('text', previous.numbered);
	}
	let timedOut = false;
	// 10 分たったらダイアログを閉じる（閉じきれずに後から押されても実行せず、通知で知らせる）
	const closing = new CancellationTokenSource();
	const answer = dialogService.prompt<'once' | 'remember' | 'deny'>({
		type: Severity.Warning,
		// allow-any-unicode-next-line
		message: request.previous !== undefined ? localize('paradis.taskBoard.relay.confirmChanged', "タスクボードの工程のコマンドが変わりました。実行しますか？") : localize('paradis.taskBoard.relay.confirmNew', "タスクボードの工程のコマンドを、SSH の接続先で実行しますか？"),
		detail,
		custom: { markdownDetails: [{ markdown }] },
		buttons: [
			// allow-any-unicode-next-line
			{ label: localize('paradis.taskBoard.relay.deny', "実行しない"), run: () => 'deny' },
			// allow-any-unicode-next-line
			{ label: localize('paradis.taskBoard.relay.once', "今回だけ実行"), run: () => 'once' },
			// allow-any-unicode-next-line
			{ label: localize('paradis.taskBoard.relay.remember', "実行して覚える"), run: () => 'remember' },
		],
		cancelButton: { run: () => 'deny' },
		token: closing.token,
	}).then(result => {
		const value = result.result ?? 'deny';
		if (timedOut && value !== 'deny') {
			// allow-any-unicode-next-line
			notificationService.info(localize('paradis.taskBoard.relay.confirmExpired', "確認の時間（10 分）が過ぎていたので、タスクボードの工程のコマンドは実行しませんでした。ボードからやり直してください。"));
		}
		return value;
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<'deny'>(resolve => timer = setTimeout(() => {
		timedOut = true;
		closing.cancel();
		resolve('deny');
	}, PARADIS_TASK_BOARD_RELAY_CONFIRM_TIMEOUT_MS));
	try {
		return await Promise.race([answer, timeout]);
	} finally {
		clearTimeout(timer);
		closing.dispose();
	}
}

/** リポジトリ（uri.toString()）ごとの記録。 */
const RECORD_STORAGE_KEY = 'paradis.taskBoard.relayRecords';
/** 覚えておくリポジトリの数（古いものから落とす）。 */
const MAX_REPOSITORIES = 50;

class ParadisTaskBoardRelaySessionsService extends ParadisTaskBoardRelaySessions implements IParadisTaskBoardRelaySessionsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IParadisWorkspaceSwitchService switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IStorageService storageService: IStorageService,
		@ILogService logService: ILogService,
		@IDialogService dialogService: IDialogService,
		@INotificationService notificationService: INotificationService,
	) {
		const approvals = (): Record<string, IParadisTaskBoardRelayApproval> => {
			try {
				const value: unknown = JSON.parse(storageService.get(APPROVAL_STORAGE_KEY, StorageScope.APPLICATION, '{}'));
				return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, IParadisTaskBoardRelayApproval> : {};
			} catch {
				return {};
			}
		};
		const readAll = (): Record<string, IParadisTaskBoardRelayRecord> => {
			try {
				const value: unknown = JSON.parse(storageService.get(RECORD_STORAGE_KEY, StorageScope.APPLICATION, '{}'));
				return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, IParadisTaskBoardRelayRecord> : {};
			} catch {
				return {};
			}
		};
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
		super({
			remoteAuthority: environmentService.remoteAuthority,
			remoteChannel: () => remoteAgentService.getConnection()?.getChannel(PARADIS_TASK_BOARD_REMOTE_CHANNEL),
			bridge: sharedProcessService.getChannel(PARADIS_TASK_BOARD_BRIDGE_CHANNEL),
			isWindowFolder: uri => switchService.repositories.some(repository => isEqual(repository.uri, uri))
				|| paradisListSpaces(switchService.repositories, worktreeService).some(space => isEqual(space.uri, uri)),
			newSessionId: () => generateUuid().replace(/-/g, ''),
			readRecord: repository => {
				const record = readAll()[repository];
				const worktrees = Array.isArray(record?.worktrees) ? record.worktrees.filter((item): item is { dir: string; branch: string } => !!item && typeof item === 'object' && typeof item.dir === 'string' && typeof item.branch === 'string') : [];
				return { worktrees, branches: strings(record?.branches) };
			},
			writeRecord: (repository, record) => {
				const all = readAll();
				delete all[repository];
				all[repository] = record;
				const kept = Object.entries(all).slice(-MAX_REPOSITORIES);
				storageService.store(RECORD_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)), StorageScope.APPLICATION, StorageTarget.MACHINE);
			},
			readApproval: key => {
				const approval = approvals()[key];
				return approval && typeof approval.hash === 'string' && typeof approval.command === 'string' ? approval : undefined;
			},
			writeApproval: (key, approval) => {
				const all = approvals();
				delete all[key];
				all[key] = approval;
				storageService.store(APPROVAL_STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_APPROVALS))), StorageScope.APPLICATION, StorageTarget.MACHINE);
			},
			confirmCommand: request => confirmCommand(dialogService, notificationService, request),
			sha256: async text => {
				const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
				return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
			},
			warn: (message, error) => logService.warn(message, error),
		});
	}
}

registerSingleton(IParadisTaskBoardRelaySessionsService, ParadisTaskBoardRelaySessionsService, InstantiationType.Delayed);
