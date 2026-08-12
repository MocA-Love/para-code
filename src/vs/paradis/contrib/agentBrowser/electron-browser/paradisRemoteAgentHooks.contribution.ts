/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { PARADIS_CLAUDE_HOOK_EVENTS, PARADIS_CODEX_HOOK_EVENTS, PARADIS_NOTIFY_HOOK_RELATIVE_PATH, paradisManagedHookDefinition } from '../common/paradisAgentHooks.js';

/**
 * SSH で繋いだ先にも、エージェントの通知 hook 一式を置く。
 *
 * hook の仕組みそのものは shared process 側（paradisAgentHooksSetup.ts）にあるが、あちらは
 * homedir() で動くので常に手元にしか置かれない。接続先で動くエージェントには何も無く、
 * 実行状態のドットもモバイルのチャットミラーも動かないままになる。
 *
 * 置くのは3つ:
 *  - notify スクリプト（手元と同じもの。shared process から本文をもらう）
 *  - ポートファイル（スクリプトが通知先の番号を読むところ）
 *  - Claude / Codex の設定への hook 定義（既にあるものは触らない）
 *
 * 通知そのものは 127.0.0.1 の同じ番号へ飛ぶ。そこが手元に繋がるようにするのは
 * paradisRemoteAgentTunnel.contribution.ts の役目で、こちらは「叩く側」を用意するだけ。
 */
class ParadisRemoteAgentHooks extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.remoteAgentHooks';

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (this.environmentService.remoteAuthority !== undefined) {
			void this.install();
		}
	}

	private async install(): Promise<void> {
		try {
			const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
			// 接続中の userHome は接続先のホーム。ここから下は全て接続先のパスになる
			const home = await this.pathService.userHome();
			// スクリプトはこの場所を見て通知先の番号を読む。env は手元のパスのまま届いてしまうので、
			// 場所をスクリプトへ焼き込んでもらう
			const portFile = joinPath(home, '.para-code', 'paradis-browser-mcp.json');
			const [script, endpoint] = await Promise.all([
				channel.call<string>('getNotifyScriptContent', [portFile.path]),
				channel.call<{ port: number }>('getGatewayEndpoint'),
			]);

			const scriptFile = joinPath(home, PARADIS_NOTIFY_HOOK_RELATIVE_PATH);
			await this.fileService.writeFile(scriptFile, VSBuffer.fromString(script));
			// 実行権が要る。IFileService には chmod が無いので、shared process 側へ頼む
			await channel.call('markRemoteHookExecutable', [this.environmentService.remoteAuthority, scriptFile.path]);

			// 手元と同じ番号を書いておく。トンネルが張られている限りそのまま手元へ届く
			await this.fileService.writeFile(portFile, VSBuffer.fromString(JSON.stringify({ protocolVersion: 1, port: endpoint.port })));

			await this.mergeClaudeHooks(home, scriptFile.path);
			await this.mergeCodexHooks(home, scriptFile.path);
			this.logService.trace(`[paradis] installed the agent hooks on ${this.environmentService.remoteAuthority}`);
		} catch (error) {
			// 置けなくても接続そのものは使える。実行状態が出ないだけ
			this.logService.warn('[paradis] could not install the agent hooks on the host', error);
		}
	}

	/** Claude Code の settings.json へ hook を足す。既存の内容は保つ。 */
	private async mergeClaudeHooks(home: URI, scriptPath: string): Promise<void> {
		const file = joinPath(home, '.claude', 'settings.json');
		const command = `[ -x "${scriptPath}" ] && "${scriptPath}" || true`;
		await this.mergeJson(file, current => {
			const settings = current as { hooks?: Record<string, unknown[]> };
			const hooks = settings.hooks ?? {};
			for (const event of PARADIS_CLAUDE_HOOK_EVENTS) {
				const definition = paradisManagedHookDefinition(event, command);
				const list = Array.isArray(hooks[event.eventName]) ? hooks[event.eventName] : [];
				// 同じスクリプトを指す定義が既にあるなら足さない（起動のたびに増やさない）
				if (!list.some(entry => JSON.stringify(entry).includes(scriptPath))) {
					list.push(definition);
				}
				hooks[event.eventName] = list;
			}
			return { ...settings, hooks };
		});
	}

	/** Codex の hooks.json へ hook を足す。 */
	private async mergeCodexHooks(home: URI, scriptPath: string): Promise<void> {
		const file = joinPath(home, '.codex', 'hooks.json');
		const command = `[ -x "${scriptPath}" ] && "${scriptPath}" || true`;
		await this.mergeJson(file, current => {
			const settings = current as { hooks?: Record<string, unknown[]> };
			const hooks = settings.hooks ?? {};
			for (const event of PARADIS_CODEX_HOOK_EVENTS) {
				const definition = paradisManagedHookDefinition(event, command);
				const list = Array.isArray(hooks[event.eventName]) ? hooks[event.eventName] : [];
				if (!list.some(entry => JSON.stringify(entry).includes(scriptPath))) {
					list.push(definition);
				}
				hooks[event.eventName] = list;
			}
			return { ...settings, hooks };
		});
	}

	/**
	 * JSON ファイルを読んで書き戻す。読めない・壊れている場合は**何もしない**
	 * （ユーザーの設定を壊すくらいなら、実行状態が出ない方がまし）。
	 */
	private async mergeJson(file: URI, update: (current: object) => object): Promise<void> {
		let current: object = {};
		if (await this.fileService.exists(file)) {
			try {
				const content = await this.fileService.readFile(file);
				const parsed: unknown = JSON.parse(content.value.toString());
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return;
				}
				current = parsed;
			} catch {
				return;
			}
		}
		await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(update(current), undefined, 2) + '\n'));
	}
}

registerWorkbenchContribution2(ParadisRemoteAgentHooks.ID, ParadisRemoteAgentHooks, WorkbenchPhase.AfterRestored);
