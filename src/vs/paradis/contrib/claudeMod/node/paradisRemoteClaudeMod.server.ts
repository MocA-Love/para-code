/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）で、そこのペインの Claude Code に Para Code の mod を読ませてよいかを確かめるチャネル。
// `paradis.server.contribution.ts` から副作用 import で読み込まれる。
//
// mod を写すのも env を組むのもウィンドウ側（paradisRemoteAgentHooks.contribution.ts・paradisPaneTokenService.ts）だが、
// managed 設定（`disableSideloadFlags`）と `claude --version` は claude が動く機械、つまり接続先で確かめる。
// 手元で確かめると、接続先の方針で claude が起動しなくなるのを防げない。このチャネルを持たない古い REH では、
// ウィンドウは `Unknown channel` で気づき、mod を渡さない（今までどおり hook・会話ログ・キーで動く）。

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { RemoteAgentConnectionContext } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { getResolvedShellEnv } from '../../../../platform/shell/node/shellEnv.js';
import { ParadisServerContributions } from '../../../common/paradisProcessContributions.js';
import { paradisClaudeConfigDir } from '../../agentBrowser/node/paradisAgentHome.js';
import { paradisProbeClaudeVersionOutput } from '../../agentBrowser/node/paradisAgentHooksSetup.js';
import { IParadisRemoteClaudeModStatus, PARADIS_REMOTE_CLAUDE_MOD_CHANNEL, paradisClaudeManagedSettingsBlockMods, paradisClaudeManagedSettingsPaths } from '../common/paradisClaudeMod.js';

/** `claude --version` を使い回す時間（ウィンドウは 5 分ごとに聞き直す）。 */
const VERSION_CACHE_MS = 5 * 60_000;

/** plist は先頭のこれだけを見る（キーの名前は ASCII のまま入っている）。 */
const PLIST_READ_LIMIT = 1_048_576;

/**
 * この機械の managed 設定が mod（`CLAUDE_CODE_PLUGIN_DIRS`）を禁じていそうか。macOS / Linux 以外は true。
 * 探す場所は手元と同じ（paradisClaudeManagedSettingsPaths）。読めないファイルは飛ばす（ふつうは無い）。
 */
export async function paradisRemoteClaudeModBlockedByPolicy(platform: NodeJS.Platform, home: string, claudeConfigDirs: readonly string[]): Promise<boolean> {
	if (platform !== 'linux' && platform !== 'darwin') {
		return true;
	}
	const { files, dropInDirectories } = paradisClaudeManagedSettingsPaths(platform === 'darwin', home, claudeConfigDirs);
	const candidates = [...files];
	for (const directory of dropInDirectories) {
		try {
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				if (!entry.isDirectory() && entry.name.endsWith('.json')) {
					candidates.push({ path: join(directory, entry.name), format: 'json' });
				}
			}
		} catch {
			// 無い（ふつうは無い）
		}
	}
	for (const candidate of candidates) {
		let text: string;
		try {
			const content = await fs.readFile(candidate.path);
			text = candidate.format === 'plist' ? content.subarray(0, PLIST_READ_LIMIT).toString('latin1') : content.toString('utf8');
		} catch {
			continue;
		}
		if (paradisClaudeManagedSettingsBlockMods(text, candidate.format)) {
			return true;
		}
	}
	return false;
}

class ParadisRemoteClaudeModChannel implements IServerChannel<RemoteAgentConnectionContext> {

	private version: { readonly at: number; readonly value: Promise<string | undefined> } | undefined;

	constructor(private readonly resolveShellEnv: () => Promise<NodeJS.ProcessEnv>) { }

	listen<T>(_ctx: RemoteAgentConnectionContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: RemoteAgentConnectionContext, command: string): Promise<T> {
		switch (command) {
			case 'getStatus': return this.getStatus() as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}

	private async getStatus(): Promise<IParadisRemoteClaudeModStatus> {
		const home = homedir();
		const configDirs = [join(home, '.claude')];
		const configured = paradisClaudeConfigDir();
		if (!configDirs.includes(configured)) {
			configDirs.push(configured);
		}
		const [blockedByPolicy, versionOutput] = await Promise.all([
			paradisRemoteClaudeModBlockedByPolicy(process.platform, home, configDirs).catch(() => true),
			this.claudeVersion(),
		]);
		return versionOutput !== undefined ? { blockedByPolicy, versionOutput } : { blockedByPolicy };
	}

	/** 接続先の `claude --version`（ログインシェルの PATH で探す）。失敗した結果は使い回さない。 */
	private claudeVersion(): Promise<string | undefined> {
		const now = Date.now();
		if (this.version === undefined || now - this.version.at > VERSION_CACHE_MS) {
			const value = paradisProbeClaudeVersionOutput(this.resolveShellEnv).catch(() => undefined);
			this.version = { at: now, value };
			void value.then(output => {
				if (output === undefined && this.version?.value === value) {
					this.version = undefined;
				}
			});
		}
		return this.version.value;
	}
}

ParadisServerContributions.register('remoteClaudeMod', ({ server, accessor }) => {
	const configurationService = accessor.get(IConfigurationService);
	const logService = accessor.get(ILogService);
	const args = accessor.get(INativeEnvironmentService).args;
	server.registerChannel(PARADIS_REMOTE_CLAUDE_MOD_CHANNEL, new ParadisRemoteClaudeModChannel(
		() => getResolvedShellEnv(configurationService, logService, args, process.env),
	));
});
