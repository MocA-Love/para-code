/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH接続先向けの「MCP接続設定」タブのロジック。
//
// shared process の ParadisMcpSetupController（node/paradisMcpSetup.ts）は常にローカルの
// os.homedir() を読み書きし、Claude Code は `claude mcp add` をローカルの子プロセスとして
// 起動する。SSH接続中のウィンドウでこれを使うと、接続先ではなく手元のPCの設定ファイルを
// 見てしまい（実機で確認済み: SSH接続中でも ~/.claude.json というローカルの絶対パスが
// 表示される）、「設定を入れ直す」を押しても接続先の問題は直らない。
//
// こちらは IFileService（接続中は接続先を透過的に読み書きする）だけで完結させる。判定・
// 書き込みの実体は paradisRemoteAgentHooks.contribution.ts（SSH接続時の自動導入）と同じ
// 純粋関数を再利用し、二重実装を避ける。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { IParadisMcpCliConfigStatus, IParadisMcpConfigStatus, IParadisMcpSetupResult, ParadisMcpCli } from '../common/paradisAgentBrowser.js';
import { computeParadisCodexTableRewrite, inspectParadisAntigravityMcpJson, inspectParadisClaudeMcpJson, inspectParadisCodexMcpToml } from '../common/paradisMcpConfigStatus.js';
import { IParadisRemoteMcpStdioBridgeLocation, paradisAntigravityRemoteMcpServerEntry, paradisCodexMcpTableBody, paradisUpsertAntigravityMcpJson, paradisUpsertCodexMcpToml } from '../common/paradisMcpSetupEncoding.js';
import { paradisMergeRemoteClaudeMcpJson } from './paradisRemoteAgentHooks.contribution.js';
import { paradisWriteRollingBackupUri } from '../../../common/paradisRollingFileBackupUri.js';

// ~/.claude.json は会話履歴などを含みうるため大きくなりやすい。node/paradisMcpSetup.ts の
// ローカル版と同じ上限に揃える（読むのは判定のためだけで、際限なくSSH越しに転送しない）。
const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const MAX_ANTIGRAVITY_CONFIG_BYTES = 1024 * 1024;

const CODEX_SETUP_ERROR = 'Could not update the Codex configuration on the host.';
const CLAUDE_SETUP_ERROR = 'Could not update the Claude Code configuration on the host.';
const TUNNEL_UNAVAILABLE_ERROR = 'Could not reach the host: the SSH return tunnel is not available yet.';
const HOST_HOME_UNAVAILABLE_ERROR = 'Could not reach the host: the host home directory is not resolved yet.';
const ANTIGRAVITY_SETUP_ERROR = 'Could not update the Antigravity CLI configuration on the host.';
const ANTIGRAVITY_BRIDGE_UNAVAILABLE_ERROR = 'The Para Code server on the host does not include the para-browser bridge for Antigravity CLI. Update Para Code and reconnect.';

/** 書き込み時に一時ファイル経由でリネームさせる。SSH越しの切断で全文書きかけのまま壊さないため。 */
const ATOMIC_WRITE_OPTIONS = { atomic: { postfix: '.para-tmp' } } as const;

export class ParadisRemoteMcpSetupController {

	constructor(
		private readonly fileService: IFileService,
		/**
		 * 接続先のホーム。まだ接続先の環境が解決できていないときは undefined。
		 *
		 * `IPathService.userHome()` をそのまま渡してはいけない。あれは接続先の環境が取れないと
		 * 黙って手元のホームを返すので、接続先向けの番号を手元の設定へ書いてしまう
		 * （`common/paradisRemoteUserHome.ts` を通すこと）。
		 */
		private readonly remoteHome: () => Promise<URI | undefined>,
		/** 接続先で戻りトンネルが実際に受け取った番号。張れていなければ undefined。 */
		private readonly remotePort: () => Promise<number | undefined>,
		/**
		 * 接続先の Antigravity CLI に書く橋渡し（REH の node と、REH に同梱したシム。paradisRemoteMcpBridge.ts）。
		 * 渡さない・決まらない（古い REH）ときは、接続先の Antigravity CLI を扱わない。
		 */
		private readonly remoteBridge?: () => Promise<IParadisRemoteMcpStdioBridgeLocation | undefined>,
	) { }

	async status(): Promise<IParadisMcpConfigStatus> {
		const [home, port] = await Promise.all([this.remoteHome(), this.remotePort()]);
		if (home === undefined) {
			// 接続先の設定を読めていないだけで、手元の設定を代わりに見せてはいけない
			// （「接続先は設定済み」と誤って出す方が、状態が出ないより悪い）
			return {
				claude: { cli: 'claude', state: 'unconfigured', failed: true },
				codex: { cli: 'codex', state: 'unconfigured', failed: true },
				...(port !== undefined ? { gatewayPort: port } : {}),
			};
		}
		const [claude, codex, antigravity] = await Promise.all([
			this.statusClaude(home, port),
			this.statusCodex(home, port),
			this.statusAntigravity(home),
		]);
		return { claude, codex, ...(antigravity !== undefined ? { antigravity } : {}), ...(port !== undefined ? { gatewayPort: port } : {}) };
	}

	async fix(cli: ParadisMcpCli): Promise<IParadisMcpSetupResult> {
		const [home, port] = await Promise.all([this.remoteHome(), this.remotePort()]);
		if (home === undefined) {
			return { cli, cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: HOST_HOME_UNAVAILABLE_ERROR }] };
		}
		// Antigravity CLI の橋渡しは番号を書かない（シムが接続先のポートファイルを読む）ので、戻りトンネルを待たない
		if (cli === 'antigravity') {
			return this.fixAntigravity(home);
		}
		if (port === undefined) {
			return { cli, cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: TUNNEL_UNAVAILABLE_ERROR }] };
		}
		switch (cli) {
			case 'claude': return this.fixClaude(home, port);
			case 'codex': return this.fixCodex(home, port);
		}
	}

	private async statusClaude(home: URI, port: number | undefined): Promise<IParadisMcpCliConfigStatus> {
		const file = joinPath(home, '.claude.json');
		const text = await this.readFileIfExists(file, MAX_CLAUDE_CONFIG_BYTES);
		if (text === undefined) {
			return { cli: 'claude', state: 'unconfigured' };
		}
		if (text === null) {
			return { cli: 'claude', state: 'unconfigured', failed: true };
		}
		const state = inspectParadisClaudeMcpJson(text, port);
		return { cli: 'claude', state, ...(state === 'configured' ? { configPath: file.path } : {}) };
	}

	private async statusCodex(home: URI, port: number | undefined): Promise<IParadisMcpCliConfigStatus> {
		const file = joinPath(home, '.codex', 'config.toml');
		const text = await this.readFileIfExists(file, MAX_CODEX_CONFIG_BYTES);
		if (text === undefined) {
			return { cli: 'codex', state: 'unconfigured' };
		}
		if (text === null) {
			return { cli: 'codex', state: 'unconfigured', failed: true };
		}
		const inspection = inspectParadisCodexMcpToml(text, port);
		return {
			cli: 'codex',
			state: inspection.state,
			...(inspection.detectedPort !== undefined ? { detectedPort: inspection.detectedPort } : {}),
			...(inspection.state === 'configured' ? { configPath: file.path } : {}),
		};
	}

	/** 接続先の Antigravity CLI の全体の設定のフォルダ（`~/.gemini/config`）。 */
	private antigravityConfigDir(home: URI): URI {
		return joinPath(home, '.gemini', 'config');
	}

	private async antigravityEntry(): Promise<ReturnType<typeof paradisAntigravityRemoteMcpServerEntry> | undefined> {
		const bridge = await this.remoteBridge?.().catch(() => undefined);
		return bridge === undefined ? undefined : paradisAntigravityRemoteMcpServerEntry(bridge);
	}

	/**
	 * 接続先の Antigravity CLI の状態。agy が設定のフォルダを作っていない（接続先で agy を使っていない）とき、
	 * 橋渡しが決まらない（古い REH）ときは undefined にしてカードを出さない（手元と同じ規則）。
	 */
	private async statusAntigravity(home: URI): Promise<IParadisMcpCliConfigStatus | undefined> {
		const entry = await this.antigravityEntry();
		if (entry === undefined) {
			return undefined;
		}
		const configDir = this.antigravityConfigDir(home);
		if (!await this.isDirectory(configDir)) {
			return undefined;
		}
		const file = joinPath(configDir, 'mcp_config.json');
		const text = await this.readFileIfExists(file, MAX_ANTIGRAVITY_CONFIG_BYTES);
		if (text === undefined) {
			return { cli: 'antigravity', state: 'unconfigured' };
		}
		if (text === null) {
			return { cli: 'antigravity', state: 'unconfigured', failed: true };
		}
		const inspection = inspectParadisAntigravityMcpJson(text, entry);
		return {
			cli: 'antigravity',
			state: inspection.state,
			...(inspection.manualOnly ? { manualOnly: true } : {}),
			...(inspection.state === 'configured' ? { configPath: file.path } : {}),
		};
	}

	/** ボタンで入れるので、agy の `/mcp` で止めた `disabled` は外す（手元の「修正」と同じ）。 */
	private async fixAntigravity(home: URI): Promise<IParadisMcpSetupResult> {
		const configDir = this.antigravityConfigDir(home);
		const file = joinPath(configDir, 'mcp_config.json');
		const entry = await this.antigravityEntry();
		if (entry === undefined) {
			return { cli: 'antigravity', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: ANTIGRAVITY_BRIDGE_UNAVAILABLE_ERROR }] };
		}
		if (!await this.isDirectory(configDir)) {
			return { cli: 'antigravity', cliAvailable: false, target: file.path, servers: [] };
		}
		try {
			const current = await this.readFileIfExists(file, MAX_ANTIGRAVITY_CONFIG_BYTES);
			if (current === null) {
				return { cli: 'antigravity', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: ANTIGRAVITY_SETUP_ERROR }] };
			}
			const updated = paradisUpsertAntigravityMcpJson(current, entry, false);
			if (updated === undefined) {
				return { cli: 'antigravity', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: ANTIGRAVITY_SETUP_ERROR }] };
			}
			if (updated === current) {
				return { cli: 'antigravity', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'already' }] };
			}
			if (current !== undefined) {
				await paradisWriteRollingBackupUri(this.fileService, file);
			}
			await this.fileService.writeFile(file, VSBuffer.fromString(updated), ATOMIC_WRITE_OPTIONS);
			return { cli: 'antigravity', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'success' }] };
		} catch {
			return { cli: 'antigravity', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: ANTIGRAVITY_SETUP_ERROR }] };
		}
	}

	private async fixClaude(home: URI, port: number): Promise<IParadisMcpSetupResult> {
		const file = joinPath(home, '.claude.json');
		try {
			const current = await this.readFileIfExists(file, MAX_CLAUDE_CONFIG_BYTES);
			if (current === null) {
				// 存在するのに読めなかった。undefined と混同すると「無いもの」として扱われ、
				// 中身のある設定を空の骨組みで上書きしてしまう
				return { cli: 'claude', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: CLAUDE_SETUP_ERROR }] };
			}
			const updated = paradisMergeRemoteClaudeMcpJson(current, port);
			if (updated === undefined) {
				// 壊れている・想定外の形。ユーザーの設定を壊すくらいなら手を出さない
				return { cli: 'claude', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: CLAUDE_SETUP_ERROR }] };
			}
			if (updated === current) {
				return { cli: 'claude', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'already' }] };
			}
			// 接続先の利用者の設定なので、書き換える前の中身を1つだけ隣へ控える（写せなくても止めない）
			await paradisWriteRollingBackupUri(this.fileService, file);
			await this.fileService.writeFile(file, VSBuffer.fromString(updated), ATOMIC_WRITE_OPTIONS);
			return { cli: 'claude', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'success' }] };
		} catch {
			return { cli: 'claude', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: CLAUDE_SETUP_ERROR }] };
		}
	}

	/**
	 * 私たちの名前以外（chrome-devtools系）が古いポートを決め打ちしている場合は、その節だけを
	 * 書き換える（ローカル版 node/paradisMcpSetup.ts の fixCodex と同じ方針）。そうしないと、
	 * 「修正」を押しても私たちの節を足すだけで元の節が古いポートのまま残り、needsFix が
	 * 消えなくなる。一意に特定できないときは無理に触らず、para-browser の節の追記へフォールバックする。
	 */
	private async fixCodex(home: URI, port: number): Promise<IParadisMcpSetupResult> {
		const file = joinPath(home, '.codex', 'config.toml');
		try {
			const current = await this.readFileIfExists(file, MAX_CODEX_CONFIG_BYTES);
			if (current === null) {
				return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
			}
			if (current !== undefined) {
				const inspection = inspectParadisCodexMcpToml(current, port);
				if (inspection.state === 'configured') {
					return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'already' }] };
				}
				if (inspection.state === 'needsFix' && inspection.staleServerName !== undefined && inspection.staleServerName !== 'para-browser') {
					const rewritten = computeParadisCodexTableRewrite(current, inspection.staleServerName, paradisCodexMcpTableBody(port));
					if (rewritten !== undefined && rewritten !== current) {
						await paradisWriteRollingBackupUri(this.fileService, file);
						await this.fileService.writeFile(file, VSBuffer.fromString(rewritten), ATOMIC_WRITE_OPTIONS);
						return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: inspection.staleServerName, outcome: 'success' }] };
					}
					// 一意に特定できなかった。安全側で諦めず、私たちの節の追記へフォールバックする
				}
			}
			const updated = paradisUpsertCodexMcpToml(current ?? '', port);
			if (updated === current) {
				return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'already' }] };
			}
			if (current !== undefined) {
				await paradisWriteRollingBackupUri(this.fileService, file);
			}
			await this.fileService.writeFile(file, VSBuffer.fromString(updated), ATOMIC_WRITE_OPTIONS);
			return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'success' }] };
		} catch {
			return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
		}
	}

	private async isDirectory(resource: URI): Promise<boolean> {
		try {
			return (await this.fileService.stat(resource)).isDirectory;
		} catch {
			return false;
		}
	}

	/**
	 * @returns ファイルの中身。存在しなければ undefined、存在するのに読めなければ null。
	 *
	 * `IFileService.exists()` は stat が ENOENT 以外の理由（権限・I/O・切断中のSSH等）で
	 * 失敗した場合も一律 false を返す。ここで undefined と区別しないと、読めなかっただけの
	 * 既存ファイルを「無いもの」として扱ってしまい、`fixClaude`/`fixCodex` が空の骨組みで
	 * 上書きしかねない。`readFile` を直接叩いて例外の種別で判定する。
	 */
	private async readFileIfExists(file: URI, maxBytes: number): Promise<string | undefined | null> {
		try {
			const content = await this.fileService.readFile(file, { limits: { size: maxBytes } });
			return content.value.toString();
		} catch (error) {
			return toFileOperationResult(error as Error) === FileOperationResult.FILE_NOT_FOUND ? undefined : null;
		}
	}
}
