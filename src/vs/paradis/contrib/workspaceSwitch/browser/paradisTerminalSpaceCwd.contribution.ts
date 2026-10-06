/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタのターミナルを、そのタブの持ち主のスペースのフォルダで起こす。
//
// upstream は新しいシェルの開始フォルダを「その瞬間ウィンドウが開いているフォルダ」から決める。
// スペースは1ウィンドウで入れ替わるので、次の2つでタブの持ち主と違うフォルダになる。
//
// 1. 復元したタブが PTY へ繋げず、シェルを起こし直すとき。スペースの切り替えでは working set の
//    復元がフォルダの入れ替えより先に走るので、切り替え元のフォルダで起きる（再起動・更新の後に
//    「スペース A のタブが B のフォルダになっている」の原因）
// 2. 別のスペースに固定した補助ウィンドウで新しいターミナルを開くとき。メインウィンドウの
//    フォルダで起きる
//
// どちらも、持ち主が根拠から引けてフォルダが実在するときだけ手を入れ、分からなければ upstream の
// 既定のままにする。あわせて、既に取り違えて記録されたターミナルを見直すコマンドを置く。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { paradisGetTerminalCreationScopeLease } from '../../../../workbench/contrib/terminal/browser/paradisTerminalCreationScope.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisRestartedTerminalLaunch, paradisRegisterRestartedTerminalCwdResolver, paradisRegisterTerminalLaunchPreparer } from '../common/paradisTerminalLaunchPreparers.js';
import { IParadisTerminalScopeRoot } from '../common/paradisTerminalProcessScope.js';
import { IParadisSpaceFolder, ParadisTerminalSpaceAction, paradisChangeDirectoryCommand, paradisLookupRestartedShellScope, paradisReviewTerminalSpaces, paradisSpaceFolderForBackend, paradisUpstreamCwdConfigured } from '../common/paradisTerminalSpaceFolder.js';
import { IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces, paradisScopeRootPath } from '../common/paradisWorkspaceSwitch.js';
import { paradisIsAtEmptyPrompt } from '../../terminalPromptInput/browser/paradisPromptInputEmpty.js';
import { paradisGetParkedTerminalEditorStateKey } from './paradisTerminalEditorPark.js';
import { paradisTerminalRestoreStateKey } from './paradisTerminalEditorRevive.js';

/** upstream の開始フォルダの設定。 */
const UPSTREAM_TERMINAL_CWD = 'terminal.integrated.cwd';

class ParadisTerminalSpaceCwdContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisTerminalSpaceCwd';

	constructor(
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(paradisRegisterRestartedTerminalCwdResolver(launch => this.resolveRestartedShellCwd(launch)));
		this._register(paradisRegisterTerminalLaunchPreparer((shellLaunchConfig, target) => this.preparePinnedWindowTerminal(shellLaunchConfig, target)));
	}

	private spaceFolders(): IParadisSpaceFolder[] {
		return paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService).map(entry => ({ stateKey: entry.space, uri: entry.uri }));
	}

	private upstreamCwdConfigured(): boolean {
		return paradisUpstreamCwdConfigured(this.configurationService.getValue<unknown>(UPSTREAM_TERMINAL_CWD));
	}

	private async resolveRestartedShellCwd(launch: IParadisRestartedTerminalLaunch): Promise<URI | undefined> {
		if (!this.workspaceSwitchService.isManagedWorkspaceWindow || this.upstreamCwdConfigured()) {
			return undefined;
		}
		// 所属台帳のサービスが立ち上がる前（起動直後の復元）は、切り替えの復元コンテキストしか引けない。
		// そのときのメインウィンドウのフォルダは起動時のスペースそのものなので、upstream の既定で合っている。
		const stateKey = paradisLookupRestartedShellScope(launch.instanceId, launch.nonce) ?? paradisTerminalRestoreStateKey(launch.nonce);
		if (stateKey === undefined) {
			return undefined;
		}
		const folder = paradisSpaceFolderForBackend(stateKey, this.spaceFolders(), launch.remoteAuthority);
		if (folder === undefined) {
			return undefined;
		}
		// 無いフォルダを渡すとシェルが起動に失敗する。upstream の既定で起こす方がまし。
		const isFolder = await this.fileService.stat(folder).then(stat => stat.isDirectory, () => false);
		if (!isFolder) {
			this.logService.warn(`[paradisTerminalSpaceCwd] the folder of the space that owns terminal ${launch.instanceId} is missing; starting its new shell where upstream would`);
			return undefined;
		}
		this.logService.info(`[paradisTerminalSpaceCwd] terminal ${launch.instanceId} could not reattach; starting its new shell in the folder of its space`);
		return folder;
	}

	/**
	 * 別のスペースに固定した補助ウィンドウで開く新しいターミナルを、そのスペースのフォルダで起こす。
	 * どのウィンドウで作られたかは、作成時に控えたスペース（creation lease）で分かる。メイン
	 * ウィンドウで作ったものは今のスペースと一致するので触らない。
	 */
	private preparePinnedWindowTerminal(shellLaunchConfig: IShellLaunchConfig, target: TerminalLocation): void {
		if (target !== TerminalLocation.Editor
			|| shellLaunchConfig.attachPersistentProcess !== undefined
			|| shellLaunchConfig.customPtyImplementation !== undefined
			|| (typeof shellLaunchConfig.cwd === 'string' ? shellLaunchConfig.cwd.length > 0 : shellLaunchConfig.cwd !== undefined)
			|| !this.workspaceSwitchService.isManagedWorkspaceWindow
			|| this.upstreamCwdConfigured()) {
			return;
		}
		const lease = paradisGetTerminalCreationScopeLease(shellLaunchConfig);
		if (lease === undefined || lease === this.workspaceSwitchService.activeStateKey) {
			return;
		}
		const folder = paradisSpaceFolderForBackend(lease, this.spaceFolders(), this.environmentService.remoteAuthority);
		if (folder !== undefined) {
			shellLaunchConfig.cwd = folder;
		}
	}
}

registerWorkbenchContribution2(ParadisTerminalSpaceCwdContribution.ID, ParadisTerminalSpaceCwdContribution, WorkbenchPhase.BlockRestore);

/** 作業フォルダの問い合わせを待つ上限（1本あたり）。答えないターミナルは作業フォルダ不明として扱う。 */
const CWD_QUERY_TIMEOUT_MS = 2_000;

interface IParadisSpaceReviewPickItem extends IQuickPickItem {
	readonly instanceId: number;
	readonly action: ParadisTerminalSpaceAction;
	readonly changeDirectory?: string;
}

/**
 * 持ち主のスペース・タブの居場所・作業フォルダが揃っていないターミナルを一覧にして、選んだ直し方を行う。
 *
 * 以前のバージョンで、繋ぎ直しに失敗したタブのシェルが別のスペースのフォルダで起き、その
 * フォルダが所属として記録されたものが残っている。記録（nonce）は変わらないので自然には直らない。
 * どちらが正しいかはユーザーにしか分からないので、自動では動かさず、直し方を選んでもらう。
 *
 * 対象は今表示しているターミナル（今のスペースと、固定した補助ウィンドウ、パネル）だけ。待避中の
 * ターミナルは扱わない。待避中の所属を書き換えても park 台帳と working set の側は元のスペースの
 * ままなので実際には移らず、そのスペースを削除したときに別のスペースで表示中の端末を PTY ごと
 * 破棄しうる。扱うなら、台帳キーの付け替えと working set から外す口を先に用意すること。
 */
class ParadisReviewTerminalSpaceMismatchesAction extends Action2 {
	constructor() {
		super({
			id: 'paradis.workspaceSwitch.reviewTerminalSpaceMismatches',
			title: localize2('paradis.workspaceSwitch.reviewTerminalSpaceMismatches', "スペースと作業フォルダが食い違うターミナルを確認"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const scopeService = accessor.get(IParadisTerminalScopeService);
		const terminalService = accessor.get(ITerminalService);
		const terminalEditorService = accessor.get(ITerminalEditorService);
		const terminalGroupService = accessor.get(ITerminalGroupService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const auxiliaryWindowScopeService = accessor.get(IParadisAuxiliaryWindowScopeService);
		const workspaceSwitchService = accessor.get(IParadisWorkspaceSwitchService);
		const worktreeService = accessor.get(IParadisWorktreeService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		if (workspaceSwitchService.isSwitching) {
			notificationService.info(localize('paradis.terminalSpaceMismatch.switching', "スペースの切り替えが終わってから、もう一度実行してください。"));
			return;
		}
		const spaces = paradisListSpaces(workspaceSwitchService.repositories, worktreeService);
		const connectedAuthority = remoteAgentService.getConnection()?.remoteAuthority;
		const roots: IParadisTerminalScopeRoot[] = [];
		for (const space of spaces) {
			const root = paradisScopeRootPath(space.uri, connectedAuthority);
			if (root !== undefined) {
				roots.push({ root, stateKey: space.space });
			}
		}
		/** タブが今どのスペースの画面に居るか。パネル、または居場所が分からなければ undefined。 */
		const containerOf = (instance: ITerminalInstance): string | undefined => {
			if (!terminalEditorService.instances.includes(instance)) {
				return undefined;
			}
			try {
				const input = terminalEditorService.getInputFromResource(instance.resource);
				const group = input.group ?? editorGroupsService.groups.find(candidate => candidate.contains(input));
				const scope = group === undefined ? undefined : auxiliaryWindowScopeService.resolveGroup(group);
				return scope?.kind === 'managed' ? scope.stateKey : undefined;
			} catch {
				return undefined;
			}
		};
		const instances = new Map<number, ITerminalInstance>();
		for (const instance of terminalService.instances) {
			if (!instance.isDisposed
				&& scopeService.isSharedPanelTerminal?.(instance.instanceId) !== true
				&& paradisGetParkedTerminalEditorStateKey(instance.instanceId) === undefined) {
				instances.set(instance.instanceId, instance);
			}
		}
		const inputs = await Promise.all([...instances.values()].map(async instance => ({
			instanceId: instance.instanceId,
			stateKey: scopeService.getStateKeyForInstance(instance.instanceId),
			container: containerOf(instance),
			cwd: await raceTimeout(instance.getSpeculativeCwd().catch(() => undefined), CWD_QUERY_TIMEOUT_MS),
		})));
		const reviews = paradisReviewTerminalSpaces(inputs, roots);
		if (reviews.length === 0) {
			notificationService.info(localize('paradis.terminalSpaceMismatch.none', "スペースと作業フォルダが食い違うターミナルはありません（見られるのは、いま表示しているターミナルだけです）。"));
			return;
		}
		const spaceName = (stateKey: string | undefined) => stateKey === undefined ? localize('paradis.terminalSpaceMismatch.noSpace', "なし") : spaces.find(space => space.space === stateKey)?.name ?? stateKey;
		const items: (IParadisSpaceReviewPickItem | IQuickPickSeparator)[] = [];
		for (const review of reviews) {
			const instance = instances.get(review.instanceId);
			if (instance === undefined) {
				continue;
			}
			const cwd = inputs.find(input => input.instanceId === review.instanceId)?.cwd;
			items.push({
				type: 'separator',
				label: localize('paradis.terminalSpaceMismatch.terminal', "{0}（持ち主 {1} / 表示 {2} / 作業フォルダ {3}）", instance.title, spaceName(review.stateKey), spaceName(review.container), cwd ?? spaceName(review.cwdStateKey)),
			});
			// パネルのターミナルは、表示の単位であるタブ（グループ）ごと移る。
			const group = review.container === undefined ? terminalGroupService.getGroupForInstance(instance) : undefined;
			const companions = (group?.terminalInstances.length ?? 1) - 1;
			const groupNote = companions > 0 ? localize('paradis.terminalSpaceMismatch.groupNote', "同じタブの {0} 個のターミナルも一緒に移ります", companions) : undefined;
			for (const action of review.actions) {
				switch (action.kind) {
					case 'claim':
						items.push({ instanceId: review.instanceId, action, label: localize('paradis.terminalSpaceMismatch.claim', "{0} の持ち物に直す（フォルダはそのまま）", spaceName(action.stateKey)), description: groupNote });
						break;
					case 'move':
						items.push({ instanceId: review.instanceId, action, label: localize('paradis.terminalSpaceMismatch.move', "{0} へ移す", spaceName(action.stateKey)), description: groupNote });
						break;
					case 'cd': {
						const space = spaces.find(candidate => candidate.space === action.stateKey);
						const folder = space === undefined ? undefined : paradisScopeRootPath(space.uri, connectedAuthority);
						const changeDirectory = folder === undefined ? undefined : paradisChangeDirectoryCommand(instance.shellType, folder);
						// 引用の仕方が分からないシェルには、自動の `cd` を出さない。
						if (changeDirectory !== undefined) {
							items.push({
								instanceId: review.instanceId,
								action,
								changeDirectory,
								label: localize('paradis.terminalSpaceMismatch.cd', "{0} のまま、そのフォルダへ移る", spaceName(action.stateKey)),
								description: review.stateKey !== action.stateKey ? localize('paradis.terminalSpaceMismatch.cdClaims', "持ち物も {0} に直します", spaceName(action.stateKey)) : undefined,
							});
						}
						break;
					}
				}
			}
		}
		const picked = await quickInputService.pick(items, {
			placeHolder: localize('paradis.terminalSpaceMismatch.placeholder', "直し方を選んでください（選ばなかったターミナルはそのままです）"),
		});
		if (picked === undefined) {
			return;
		}
		const instance = instances.get(picked.instanceId);
		if (instance === undefined || instance.isDisposed) {
			return;
		}
		switch (picked.action.kind) {
			case 'claim':
			case 'move':
				scopeService.assignInstanceScope(picked.instanceId, picked.action.stateKey);
				return;
			case 'cd': {
				const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
				if (picked.changeDirectory === undefined || commandDetection === undefined
					|| !paradisIsAtEmptyPrompt(commandDetection)) {
					notificationService.info(localize('paradis.terminalSpaceMismatch.notAtPrompt', "シェルが入力を待っていて入力欄が空のときに実行してください。いま動いているプログラムを終えるか、入力欄を空にしてからもう一度選びます。"));
					return;
				}
				if (scopeService.getStateKeyForInstance(picked.instanceId) !== picked.action.stateKey) {
					scopeService.assignInstanceScope(picked.instanceId, picked.action.stateKey);
				}
				await instance.sendText(picked.changeDirectory, true);
				return;
			}
		}
	}
}

registerAction2(ParadisReviewTerminalSpaceMismatchesAction);
