/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { isWorkspaceIdentifier, IWorkspaceContextService, reviveIdentifier, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { paradisRemoteUserHome } from '../../agentBrowser/common/paradisRemoteUserHome.js';

const PARADIS_REMOTE_DEFAULT_WORKSPACE_SETTING = 'paradis.remote.openDefaultWorkspace';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_REMOTE_DEFAULT_WORKSPACE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			description: localize('paradis.remote.openDefaultWorkspace', "SSH で接続したウィンドウで、接続先のマルチリポワークスペースを自動で開きます。接続先ごとにリポジトリ一覧が独立します。")
		}
	}
});

/**
 * SSH で接続したウィンドウに、接続先側のマルチリポワークスペースを開く。
 *
 * ローカルウィンドウでは windowsMainService の PARA-PATCH から electron-main の
 * paradisEnsureDefaultWorkspace が同じことをしているが、あちらは homedir() 固定で
 * 常に手元を指すため、接続したウィンドウには効かない（接続先のホームは知り得ない）。
 *
 * リポジトリ一覧は StorageScope.WORKSPACE に入り、workspace id は .code-workspace の
 * 場所から決まる。したがって接続先ごとに別のワークスペースファイルを開くだけで、
 * 手元の一覧と混ざらずに分かれる。切り替え自体は接続先をまたがないので、
 * 従来どおり updateFolders の速い経路がそのまま使える。
 */
class ParadisRemoteDefaultWorkspace extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.remoteDefaultWorkspace';

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
		@IFileService private readonly fileService: IFileService,
		@IHostService private readonly hostService: IHostService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		void this.openIfNeeded();
	}

	private async openIfNeeded(): Promise<void> {
		// 接続していないウィンドウは electron-main 側が面倒を見ている
		if (!this.environmentService.remoteAuthority) {
			return;
		}
		// 既にフォルダ／ワークスペースを開いているなら触らない。
		// 「接続先を開く」で直接フォルダを指定した場合もここで抜ける。
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			return;
		}
		if (!this.configurationService.getValue<boolean>(PARADIS_REMOTE_DEFAULT_WORKSPACE_SETTING)) {
			return;
		}

		try {
			const userHome = await this.resolveRemoteUserHome();
			if (!userHome) {
				return;
			}
			const workspaceFile = joinPath(userHome, '.para-code', 'para.code-workspace');
			// 未作成なら何もしない。ローカル側の paradisEnsureDefaultWorkspace と同じ判断で、
			// 初回は「Para Code: Initialize Multi-Repo Workspace」（未初期化のときに出る通知の
			// ボタンからも辿れる）に任せる。勝手にファイルを置きに行かない。
			if (!(await this.fileService.exists(workspaceFile))) {
				return;
			}
			if (await this.yieldToWindowAlreadyShowing(workspaceFile)) {
				return;
			}
			await this.hostService.openWindow([{ workspaceUri: workspaceFile }], { forceReuseWindow: true });
			await this.yieldIfLostTheRace(workspaceFile);
		} catch (error) {
			// 開けなくても接続自体は使えるので、ウィンドウを壊さずログだけ残す
			// （接続先のホームが読めない・書き込めない構成などが該当する）
			this.logService.warn('[paradis] could not open the remote multi-repo workspace', error);
		}
	}

	/**
	 * 接続先のホーム。まだ接続先を指していないなら undefined。
	 *
	 * `pathService.userHome()` は接続先の環境が取れなかったときに黙って手元のホームを返す
	 * （`remoteAgentService.getEnvironment()` が失敗を握り潰して null を返し、pathService 側は
	 * `env?.userHome ?? localUserHome` で受ける）。初回接続でサーバー側の準備がまだのときや、
	 * サーバー再起動直後・認証待ちで普通に起こる。その結果をそのまま使うと、手元の
	 * `~/.para-code/para.code-workspace` を forceReuseWindow で開いてしまい、利用者が張った接続が
	 * 無言で消える。判定は同じ事故のために作られた paradisRemoteUserHome に任せる。
	 *
	 * このウィンドウの中で再試行はしない。pathService も remoteAgentService も結果を一度きりで
	 * 抱え込むので、同じウィンドウで何度聞いても答えは変わらない。ウィンドウは空のまま残るため、
	 * 再読み込みすれば（WorkbenchState.EMPTY の判定を通って）改めてここへ来る。
	 */
	private async resolveRemoteUserHome(): Promise<URI | undefined> {
		const userHome = paradisRemoteUserHome(this.environmentService.remoteAuthority, await this.pathService.userHome());
		if (!userHome) {
			this.logService.warn('[paradis] the remote home directory is not available yet, leaving this window empty');
		}
		return userHome;
	}

	/**
	 * 同じワークスペースを既に開いているウィンドウがあれば、そちらへ譲って true を返す。
	 *
	 * `forceReuseWindow` はこのウィンドウを再利用してくれない。windowsMainService は先に
	 * 「そのワークスペースを開いているウィンドウ」を探し、見つかるとそこへフォーカスするだけで
	 * 終わる。呼び出し元のウィンドウは一度も使われず、空のまま取り残される（しかも
	 * WorkbenchState.EMPTY のままなので、再読み込みしても同じことが起きる）。
	 * 「同じ接続先のウィンドウが2つ立ち上がり、片方がまっさら」の正体がこれ。
	 */
	private async yieldToWindowAlreadyShowing(workspaceFile: URI): Promise<boolean> {
		const windows = await this.nativeHostService.getWindows({ includeAuxiliaryWindows: false });
		const existing = windows.find(window => {
			if (window.id === this.nativeHostService.windowId) {
				return false;
			}
			// getWindows の戻りは IPC を素通りするだけで URI が復元されない。戻す前に
			// isWorkspaceIdentifier へ渡しても URI.isUri が通らず、常に取りこぼす
			const workspace = reviveIdentifier(window.workspace);
			return isWorkspaceIdentifier(workspace) && extUriBiasedIgnorePathCase.isEqual(workspace.configPath, workspaceFile);
		});
		if (!existing) {
			return false;
		}

		await this.nativeHostService.focusWindow({ targetWindowId: existing.id, mode: FocusMode.Force });
		// 空とはいえ、復元された Untitled エディタに書きかけが残っていることがある。
		// このウィンドウを閉じると、単一ウィンドウを閉じる経路は hot exit に乗らないので
		// 保存確認ダイアログが出る。利用者は何もしていないのに問われる形になるうえ、
		// 書きかけを失う恐れもあるので、その場合は閉じずに残す（見えているのは相手側）。
		if (this.workingCopyService.hasDirty) {
			this.logService.info(`[paradis] the remote multi-repo workspace is already open in window ${existing.id}; leaving this window open because it has unsaved work`);
			return true;
		}

		this.logService.info(`[paradis] the remote multi-repo workspace is already open in window ${existing.id}, closing this empty window`);
		await this.nativeHostService.closeWindow();
		return true;
	}

	/**
	 * 開いたあとにもう一度譲り先を探す。競争に負けた側を拾うための後追い。
	 *
	 * 空ウィンドウ同士は互いの `workspace` が undefined なので、開く前の照会では相手を見つけられない。
	 * 空のリモートウィンドウが2枚同時に立ち上がると両方が openWindow を投げ、main 側は先着だけを
	 * 再利用して後着には「もう開いている」とフォーカスを返すため、後着が空のまま残る。
	 *
	 * このウィンドウが再利用されたならワークベンチごと作り直されてここへは戻らない。戻ってきて
	 * なお空なら負けた側なので、勝った側（このときには workspace が載っている）へ改めて譲る。
	 * main 側の open が非同期に進む分を見て数回だけ待つ。
	 */
	private async yieldIfLostTheRace(workspaceFile: URI): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				await timeout(500);
			}
			if (this._store.isDisposed || this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
				return;
			}
			if (await this.yieldToWindowAlreadyShowing(workspaceFile)) {
				return;
			}
		}
	}
}

registerWorkbenchContribution2(ParadisRemoteDefaultWorkspace.ID, ParadisRemoteDefaultWorkspace, WorkbenchPhase.AfterRestored);
