/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CPU/RAMモニタの「現在のターミナルセッション一覧を集めてメインプロセスへ問い合わせる」
// 共通ロジック。トリガーウィジェット(paradisResourceMonitorWidget.ts、常時ポーリングの主体)と
// 内訳パネル(paradisResourceMonitorPanel.ts、表示専用)の両方から使われるため、
// 重複を避けてここに集約する。

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { Schemas } from '../../../../base/common/network.js';
import { IParadisHostResources, IParadisResourceMonitorMainService, IParadisResourceMonitorMobileReport, IParadisResourceMonitorSessionRequest, IParadisResourceMonitorSnapshot, PARADIS_HOST_RESOURCES_CHANNEL, PARADIS_RESOURCE_MONITOR_CHANNEL } from '../common/paradisResourceMonitor.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';

/** スコープに紐付かないターミナル(リスト外フォルダ等)をまとめる仮想スコープキー。 */
export const PARADIS_RESOURCE_MONITOR_OTHER_TERMINALS_STATE_KEY = '__paradis_other_terminals__';

/**
 * 現在のターミナルセッション一覧をスコープ付きで集めてメインプロセスへ問い合わせ、
 * スナップショットを返す。スコープ⇔ワークスペース切り替えの解決もここに集約する。
 */
export class ParadisResourceMonitorClient {

	private readonly resourceMonitorService: IParadisResourceMonitorMainService;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IParadisTerminalScopeService private readonly terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
	) {
		this.resourceMonitorService = ProxyChannel.toService<IParadisResourceMonitorMainService>(mainProcessService.getChannel(PARADIS_RESOURCE_MONITOR_CHANNEL));
	}

	/**
	 * マシン全体の使用量を答える側。
	 *
	 * SSH で繋いでいる間、ターミナルもエージェントも接続先で動くので、「マシンが忙しいか」は
	 * 接続先の話になる。手元の数字を出しても、詰まっているのが向こうなら何も分からない。
	 * Para Code 自身の内訳（getSnapshot）は手元のままでよい。動いているのは手元だから。
	 */
	private async readHostResources(request: { readonly diskPaths: string[]; readonly force: boolean }): Promise<IParadisHostResources> {
		const remoteConnection = this.remoteAgentService.getConnection();
		if (remoteConnection === null) {
			return this.resourceMonitorService.getHostResources(request);
		}
		// 接続先のディスクを見たいので、手元のパスは渡さない（あちらには存在しない）
		return remoteConnection.getChannel(PARADIS_HOST_RESOURCES_CHANNEL).call<IParadisHostResources>('getHostResources', { force: request.force });
	}

	getSnapshot(force: boolean): Promise<IParadisResourceMonitorSnapshot> {
		return this.resourceMonitorService.getSnapshot({ sessions: this.collectSessionRequests(), force });
	}

	/**
	 * モバイルの「システム」画面向けに、ホストマシン全体の使用量とPara Code内訳をまとめて取る。
	 * 「PCが忙しいか」と「Para Codeが重いか」は別の問いなので、必ず両方を同時に返す。
	 */
	async getMobileReport(force: boolean): Promise<IParadisResourceMonitorMobileReport> {
		const [snapshot, host] = await Promise.all([
			this.getSnapshot(force),
			this.readHostResources({ diskPaths: this.collectDiskPaths(), force }),
		]);
		return { host, snapshot };
	}

	/**
	 * 容量を見たいパス。登録済みリポジトリとその作業ツリー(worktree)を渡す。
	 * ホームのボリュームはメインプロセス側が必ず先頭に足すので、ここでは足さない。
	 * 同じボリュームを指すパスはメインプロセス側でまとめられる。
	 */
	private collectDiskPaths(): string[] {
		const paths: string[] = [];
		for (const repository of this.workspaceSwitchService.repositories) {
			if (repository.uri.scheme === Schemas.file) {
				paths.push(repository.uri.fsPath);
			}
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				if (!worktree.missing && worktree.uri.scheme === Schemas.file) {
					paths.push(worktree.uri.fsPath);
				}
			}
		}
		return paths;
	}

	/** スコープ行クリック時の切り替え。リポジトリIDまたは `worktree:` プレフィックス付きキーを解決する。 */
	switchToScope(stateKey: string): void {
		if (stateKey === PARADIS_RESOURCE_MONITOR_OTHER_TERMINALS_STATE_KEY) {
			return;
		}
		if (stateKey.startsWith('worktree:')) {
			for (const repository of this.workspaceSwitchService.repositories) {
				const worktree = this.worktreeService.getWorktrees(repository.id).find(w => paradisWorktreeStateKey(w.uri) === stateKey);
				if (worktree) {
					if (!worktree.missing) {
						void this.workspaceSwitchService.switchToWorktree(worktree);
					}
					return;
				}
			}
			return;
		}
		void this.workspaceSwitchService.switchRepository(stateKey);
	}

	private collectSessionRequests(): IParadisResourceMonitorSessionRequest[] {
		const scopeNameMap = this.buildScopeNameMap();

		const instances: ITerminalInstance[] = [...this.terminalService.instances];
		for (const group of this.terminalGroupService.paradisParkedGroups ?? []) {
			instances.push(...group.terminalInstances);
		}

		const sessions: IParadisResourceMonitorSessionRequest[] = [];
		for (const instance of instances) {
			const pid = instance.processId;
			if (typeof pid !== 'number' || pid <= 0) {
				continue;
			}
			const stateKey = this.terminalScopeService.getStateKeyForInstance(instance.instanceId);
			sessions.push({
				stateKey: stateKey ?? PARADIS_RESOURCE_MONITOR_OTHER_TERMINALS_STATE_KEY,
				scopeName: stateKey === undefined
					? localize('paradis.resourceMonitor.otherTerminals', "Other Terminals")
					: (scopeNameMap.get(stateKey) ?? stateKey),
				sessionName: instance.title || localize('paradis.resourceMonitor.terminalFallbackName', "Terminal {0}", instance.instanceId),
				pid,
			});
		}
		return sessions;
	}

	private buildScopeNameMap(): Map<string, string> {
		const map = new Map<string, string>();
		for (const repository of this.workspaceSwitchService.repositories) {
			map.set(repository.id, repository.name);
			for (const worktree of this.worktreeService.getWorktrees(repository.id)) {
				map.set(paradisWorktreeStateKey(worktree.uri), worktree.name);
			}
		}
		return map;
	}
}
