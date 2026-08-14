/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { PARADIS_NOTIFY_HOOK_RELATIVE_PATH } from '../common/paradisAgentHooks.js';
import { paradisUpsertCodexMcpToml } from '../common/paradisMcpSetupEncoding.js';

function parseRemoteAgentJson(existingRaw: string | undefined): Record<string, unknown> | undefined {
	if (existingRaw === undefined) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(existingRaw);
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function stringifyRemoteAgentJson(value: object): string {
	return JSON.stringify(value, undefined, 2) + '\n';
}

/** 既存設定を保ったまま接続先Claude用para-browser MCPをマージする。 */
export function paradisMergeRemoteClaudeMcpJson(existingRaw: string | undefined, port: number): string | undefined {
	const config = parseRemoteAgentJson(existingRaw);
	if (config === undefined) {
		return undefined;
	}
	const existingServers = config.mcpServers;
	const servers: Record<string, unknown> = existingServers !== null && typeof existingServers === 'object' && !Array.isArray(existingServers)
		? { ...existingServers as Record<string, unknown> }
		: {};
	servers['para-browser'] = {
		type: 'http',
		url: `http://127.0.0.1:${port}/`,
		headers: { Authorization: 'Bearer ${PARA_CODE_TERMINAL_PANE_ID}' }
	};
	return stringifyRemoteAgentJson({ ...config, mcpServers: servers });
}

/** 接続先への hook 導入を再試行し、ゲートウェイ番号の変化に追従する。 */
export class ParadisRemoteAgentHooksController extends Disposable {

	/** 接続先へ書き込んだゲートウェイの番号。変わったら書き直す目印。 */
	private installedPort: number | undefined;
	private isPolling = false;

	constructor(
		private readonly install: () => Promise<number | undefined>,
		private readonly readEndpoint: () => Promise<{ readonly port: number }>,
		private readonly delay: (delayMs: number) => Promise<void>,
		private readonly interval: (callback: () => Promise<void>, intervalMs: number) => IDisposable,
		private readonly logService: Pick<ILogService, 'info' | 'warn'>,
	) {
		super();
		void this.installWithRetry();
	}

	/** 接続先が使えるまで既定の4段階で hook 導入を再試行する。 */
	private async installWithRetry(): Promise<void> {
		const delaysMs = [0, 2000, 5000, 15000];
		for (let attempt = 0; attempt < delaysMs.length; attempt++) {
			if (this._store.isDisposed) {
				return;
			}
			if (delaysMs[attempt] > 0) {
				await this.delay(delaysMs[attempt]);
			}
			if (this._store.isDisposed) {
				return;
			}
			const installedPort = await this.install();
			if (installedPort !== undefined) {
				if (this._store.isDisposed) {
					return;
				}
				this.installedPort = installedPort;
				this.watchForPortChanges();
				return;
			}
		}
		this.logService.warn('[paradis] gave up installing the agent hooks on the host');
	}

	/** ゲートウェイ番号が変わったときだけ接続先へ hook 一式を再導入する。 */
	private watchForPortChanges(): void {
		this._register(this.interval(async () => {
			if (this._store.isDisposed || this.isPolling) {
				return;
			}
			this.isPolling = true;
			try {
				const endpoint = await this.readEndpoint();
				if (this._store.isDisposed || endpoint.port === this.installedPort) {
					return;
				}
				this.logService.info(`[paradis] gateway port changed (${this.installedPort} -> ${endpoint.port}); updating the host`);
				const installedPort = await this.install();
				if (!this._store.isDisposed && installedPort !== undefined) {
					this.installedPort = installedPort;
				}
			} catch {
				// 取れないときは次の周期で試す
			} finally {
				this.isPolling = false;
			}
		}, 30_000));
	}
}

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
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
	) {
		super();

		// SSH の接続先だけを対象にする。他の種類の接続先（WSL・コンテナ）は ssh を通らないので、
		// 置いたものへ実行権も付けられず、ソケットも引けない
		if (this.environmentService.remoteAuthority?.startsWith('ssh-remote+') === true) {
			const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
			// ペインが増減するたび、接続先の Codex ソケットの引き込みを合わせ直す
			this._register(this.paneTokenService.onDidChange(() => {
				void this.pathService.userHome().then(home => this.syncCodexSockets(home, channel), () => undefined);
			}));
			this._register({
				dispose: () => {
					channel.call('releaseRemoteCodexSockets', [this.environmentService.remoteAuthority])
						.catch(() => undefined);
				}
			});
			this._register(new ParadisRemoteAgentHooksController(
				() => this.install(channel),
				() => channel.call<{ port: number }>('getGatewayEndpoint'),
				delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
				(callback, intervalMs) => disposableWindowInterval(mainWindow, callback, intervalMs),
				this.logService,
			));
		}
	}

	/** @returns 置けたゲートウェイ番号。まだ整っていないだけなら undefined（呼び出し側が試し直す） */
	private async install(channel: IChannel): Promise<number | undefined> {
		try {
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

			await this.installCodexLauncher(home, channel);

			await this.mergeAgentHooks(joinPath(home, '.claude', 'settings.json'), 'claude');
			await this.mergeAgentHooks(joinPath(home, '.codex', 'hooks.json'), 'codex');
			await this.mergeClaudeMcp(home, endpoint.port);
			await this.mergeCodexMcp(home, endpoint.port);
			this.syncCodexSockets(home, channel);
			this.logService.info(`[paradis] installed the agent hooks on ${this.environmentService.remoteAuthority} (port ${endpoint.port})`);
			return endpoint.port;
		} catch (error) {
			// 置けなくても接続そのものは使える。実行状態が出ないだけ
			this.logService.warn('[paradis] could not install the agent hooks on the host (will retry)', error);
			return undefined;
		}
	}

	/**
	 * Codex のペイン専用ランチャーを接続先へ置く。
	 *
	 * Codex の承認カードやモデル一覧は、TUI の画面ではなく app-server との構造化されたやり取りで
	 * 取っている。それを立てるのがこのランチャーで、PATH の先頭に置かれて `codex` の代わりに
	 * 呼ばれる。手元のものは Para Code の中にあり接続先からは見えないので、同じものを置く。
	 *
	 * 中身は素の sh スクリプトで、何か揃わなければ本物の codex をそのまま実行する作りになって
	 * いる。置くこと自体が Codex を壊す方向には働かない。
	 */
	private async installCodexLauncher(home: URI, channel: IChannel): Promise<void> {
		const appRoot = (this.environmentService as IWorkbenchEnvironmentService & { readonly appRoot?: string }).appRoot;
		if (typeof appRoot !== 'string' || appRoot.length === 0) {
			return;
		}
		// 手元のファイルを読む。接続中のウィンドウでも `file:` はこの機械を指す
		const source = URI.file(`${appRoot}/resources/paradis/bin/codex`);
		const content = await this.fileService.readFile(source).catch(() => undefined);
		if (content === undefined) {
			this.logService.warn('[paradis] could not read the Codex launcher to copy to the host');
			return;
		}
		const target = joinPath(home, '.para-code', 'bin', 'codex');
		const existing = await this.fileService.readFile(target).catch(() => undefined);
		if (existing !== undefined && existing.value.toString() === content.value.toString()) {
			return; // 既に同じもの。30秒ごとの見直しで毎回コピーし直さない
		}
		// 走っている Codex のシェルは、このファイルを開いたまま最後まで読み進める。上書きすると
		// 途中から別の中身を読んで死ぬので、別名で書いてから置き換える（開いている側は古い実体を
		// 見続ける）
		const staging = joinPath(home, '.para-code', 'bin', `codex.${generateUuid()}`);
		await this.fileService.writeFile(staging, content.value);
		await channel.call('markRemoteHookExecutable', [this.environmentService.remoteAuthority, staging.path]);
		await this.fileService.move(staging, target, true);
	}

	/**
	 * 接続先の Codex ペインのソケットを、手元の同じ場所へ引いてくるよう頼む。
	 *
	 * ペインは開いたり閉じたりするので、その都度いまある一覧を渡して同期させる。手元のソケットの
	 * 場所は shared process が決める（ウィンドウの言い値でソケットを作らせない）。
	 */
	private syncCodexSockets(home: URI, channel: IChannel): void {
		const tokens = this.paneTokenService.listPaneTokens().map(pane => pane.token);
		channel.call('syncRemoteCodexSockets', [this.environmentService.remoteAuthority, joinPath(home, '.para-code').path, tokens])
			.catch(error => this.logService.trace('[paradis] could not sync the Codex sockets with the host', error));
	}

	/**
	 * 接続先の settings.json / hooks.json へ hook を差し込む。
	 *
	 * 何を入れるかは shared process（手元と同じ判断をする側）に決めてもらい、ここは読み書きだけを
	 * 担う。renderer で組み立て直すと入るものがずれる: 実際、手元は `$HOME/...` 形で書くのに
	 * こちらは絶対パス形で書いていたため、同じ hook が2つ登録されて通知が毎回2回飛んでいた。
	 */
	private async mergeAgentHooks(file: URI, cli: 'claude' | 'codex'): Promise<void> {
		const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
		await this.mergeJson(file, current => channel.call<string | undefined>(
			'buildRemoteAgentHooksJson',
			[this.environmentService.remoteAuthority, cli, current]
		));
	}

	/**
	 * 接続先の Claude Code へ para-browser MCP を登録する。
	 *
	 * MCP サーバーの実体は手元の shared process にあり、素の HTTP で話せる。接続先からは
	 * 戻り経路（paradisRemoteAgentTunnel）で同じ番号に届くので、そこを URL に書けばよい。
	 * シムを接続先へ置く必要はない（あれは stdio を HTTP へ橋渡しするだけのもの）。
	 *
	 * トークンはペインごとに違うため、値を焼き込まず `${PARA_CODE_TERMINAL_PANE_ID}` の
	 * まま書く。エージェントはターミナルの env を継いで起動するので、そこで解決される。
	 */
	private async mergeClaudeMcp(home: URI, port: number): Promise<void> {
		const file = joinPath(home, '.claude.json');
		await this.mergeJson(file, current => paradisMergeRemoteClaudeMcpJson(current, port));
	}

	/**
	 * 接続先の Codex へ para-browser MCP を登録する。
	 *
	 * Claude と同じく HTTP で繋ぐ。接続先の設定に手元のシムのパスが書かれていることがあり
	 * （設定を移した副産物）、そのままでは存在しないファイルを起動しようとして失敗するので、
	 * 既にある para-browser の節ごと置き換える。
	 *
	 * トークンはペインごとに違うので値を焼き込まず、環境変数の名前だけを渡す
	 * （Codex が起動時にその変数を読んで Bearer に載せる）。
	 */
	private async mergeCodexMcp(home: URI, port: number): Promise<void> {
		const file = joinPath(home, '.codex', 'config.toml');
		await this.mergeJson(file, current => paradisUpsertCodexMcpToml(current ?? '', port));
	}

	/**
	 * JSON ファイルを読んで書き戻す。読めない・壊れている場合は**何もしない**
	 * （ユーザーの設定を壊すくらいなら、実行状態が出ない方がまし）。
	 */
	private async mergeJson(file: URI, update: (current: string | undefined) => string | undefined | Promise<string | undefined>): Promise<void> {
		let current: string | undefined;
		if (await this.fileService.exists(file)) {
			try {
				const content = await this.fileService.readFile(file);
				current = content.value.toString();
			} catch {
				return;
			}
		}
		const updated = await update(current);
		if (updated !== undefined && updated !== current) {
			await this.fileService.writeFile(file, VSBuffer.fromString(updated));
		}
	}
}

registerWorkbenchContribution2(ParadisRemoteAgentHooks.ID, ParadisRemoteAgentHooks, WorkbenchPhase.AfterRestored);
