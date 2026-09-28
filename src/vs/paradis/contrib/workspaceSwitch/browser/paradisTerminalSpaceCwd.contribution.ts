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
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IShellLaunchConfig, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisGetTerminalCreationScopeLease } from '../../../../workbench/contrib/terminal/browser/paradisTerminalCreationScope.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisRestartedTerminalLaunch, paradisRegisterRestartedTerminalCwdResolver, paradisRegisterTerminalLaunchPreparer } from '../common/paradisTerminalLaunchPreparers.js';
import { IParadisTerminalScopeRoot } from '../common/paradisTerminalProcessScope.js';
import { IParadisSpaceFolder, paradisFindTerminalSpaceMismatches, paradisLookupRestartedShellScope, paradisSpaceFolderForBackend, paradisUpstreamCwdConfigured } from '../common/paradisTerminalSpaceFolder.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces, paradisScopeRootPath } from '../common/paradisWorkspaceSwitch.js';
import { paradisListParkedTerminalEditorInstances } from './paradisTerminalEditorPark.js';
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

/** 作業フォルダの問い合わせを待つ上限（1本あたり）。答えないターミナルは一覧から外す。 */
const CWD_QUERY_TIMEOUT_MS = 2_000;

interface IParadisSpaceMismatchPickItem extends IQuickPickItem {
	readonly instanceId: number;
	readonly cwdStateKey: string;
}

/**
 * 持ち主のスペースと作業フォルダが食い違うターミナルを一覧にして、作業フォルダのスペースへ移す。
 *
 * 以前のバージョンで、繋ぎ直しに失敗したタブのシェルが別のスペースのフォルダで起き、そのまま
 * 元のスペースの持ち物として記録されたものが残っている。記録（nonce）は変わらないので自然には
 * 直らない。どちらが正しいかはユーザーにしか分からないので、自動では動かさず選んだものだけ移す。
 * 見えるのはこのウィンドウが持っているターミナル（今のスペースのものと、待避中のもの）だけ。
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
		const workspaceSwitchService = accessor.get(IParadisWorkspaceSwitchService);
		const worktreeService = accessor.get(IParadisWorktreeService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const spaces = paradisListSpaces(workspaceSwitchService.repositories, worktreeService);
		const connectedAuthority = remoteAgentService.getConnection()?.remoteAuthority;
		const roots: IParadisTerminalScopeRoot[] = [];
		for (const space of spaces) {
			const root = paradisScopeRootPath(space.uri, connectedAuthority);
			if (root !== undefined) {
				roots.push({ root, stateKey: space.space });
			}
		}
		const instances = new Map<number, ITerminalInstance>();
		for (const instance of [...terminalService.instances, ...paradisListParkedTerminalEditorInstances()]) {
			if (!instance.isDisposed && scopeService.isSharedPanelTerminal?.(instance.instanceId) !== true) {
				instances.set(instance.instanceId, instance);
			}
		}
		const inputs = await Promise.all([...instances.values()].map(async instance => ({
			instanceId: instance.instanceId,
			stateKey: scopeService.getStateKeyForInstance(instance.instanceId),
			cwd: await raceTimeout(instance.getSpeculativeCwd().catch(() => undefined), CWD_QUERY_TIMEOUT_MS),
		})));
		const mismatches = paradisFindTerminalSpaceMismatches(inputs, roots);
		if (mismatches.length === 0) {
			notificationService.info(localize('paradis.terminalSpaceMismatch.none', "スペースと作業フォルダが食い違うターミナルはありません（見られるのは、このウィンドウで一度開いたスペースのターミナルだけです）。"));
			return;
		}
		const spaceName = (stateKey: string) => spaces.find(space => space.space === stateKey)?.name ?? stateKey;
		const items: IParadisSpaceMismatchPickItem[] = mismatches.map(mismatch => ({
			instanceId: mismatch.instanceId,
			cwdStateKey: mismatch.cwdStateKey,
			label: instances.get(mismatch.instanceId)?.title ?? String(mismatch.instanceId),
			description: localize('paradis.terminalSpaceMismatch.item', "{0} のタブ / 作業フォルダは {1}", spaceName(mismatch.stateKey), spaceName(mismatch.cwdStateKey)),
			detail: inputs.find(input => input.instanceId === mismatch.instanceId)?.cwd,
		}));
		const picked = await quickInputService.pick(items, {
			canPickMany: true,
			placeHolder: localize('paradis.terminalSpaceMismatch.placeholder', "作業フォルダのスペースへ移すターミナルを選んでください（選ばなかったものはそのままです）"),
		});
		if (picked === undefined || picked.length === 0) {
			return;
		}
		for (const item of picked) {
			scopeService.assignInstanceScope(item.instanceId, item.cwdStateKey);
		}
		notificationService.info(localize('paradis.terminalSpaceMismatch.moved', "{0} 個のターミナルを作業フォルダのスペースへ移しました。", picked.length));
	}
}

registerAction2(ParadisReviewTerminalSpaceMismatchesAction);
