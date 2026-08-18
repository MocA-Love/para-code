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
import { computeParadisCodexTableRewrite, inspectParadisClaudeMcpJson, inspectParadisCodexMcpToml } from '../common/paradisMcpConfigStatus.js';
import { paradisCodexMcpTableBody, paradisUpsertCodexMcpToml } from '../common/paradisMcpSetupEncoding.js';
import { paradisMergeRemoteClaudeMcpJson } from './paradisRemoteAgentHooks.contribution.js';

// ~/.claude.json は会話履歴などを含みうるため大きくなりやすい。node/paradisMcpSetup.ts の
// ローカル版と同じ上限に揃える（読むのは判定のためだけで、際限なくSSH越しに転送しない）。
const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;

const CODEX_SETUP_ERROR = 'Could not update the Codex configuration on the host.';
const CLAUDE_SETUP_ERROR = 'Could not update the Claude Code configuration on the host.';
const TUNNEL_UNAVAILABLE_ERROR = 'Could not reach the host: the SSH return tunnel is not available yet.';

/** 書き込み時に一時ファイル経由でリネームさせる。SSH越しの切断で全文書きかけのまま壊さないため。 */
const ATOMIC_WRITE_OPTIONS = { atomic: { postfix: '.para-tmp' } } as const;

export class ParadisRemoteMcpSetupController {

	constructor(
		private readonly fileService: IFileService,
		/** 接続先のホーム（`IPathService.userHome()`。接続中は自動で接続先を指す）。 */
		private readonly remoteHome: () => Promise<URI>,
		/** 接続先で戻りトンネルが実際に受け取った番号。張れていなければ undefined。 */
		private readonly remotePort: () => Promise<number | undefined>,
	) { }

	async status(): Promise<IParadisMcpConfigStatus> {
		const [home, port] = await Promise.all([this.remoteHome(), this.remotePort()]);
		const [claude, codex] = await Promise.all([
			this.statusClaude(home, port),
			this.statusCodex(home, port),
		]);
		return { claude, codex, ...(port !== undefined ? { gatewayPort: port } : {}) };
	}

	async fix(cli: ParadisMcpCli): Promise<IParadisMcpSetupResult> {
		const [home, port] = await Promise.all([this.remoteHome(), this.remotePort()]);
		if (port === undefined) {
			return { cli, cliAvailable: true, servers: [{ server: 'para-browser', outcome: 'error', detail: TUNNEL_UNAVAILABLE_ERROR }] };
		}
		return cli === 'claude' ? this.fixClaude(home, port) : this.fixCodex(home, port);
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
			await this.fileService.writeFile(file, VSBuffer.fromString(updated), ATOMIC_WRITE_OPTIONS);
			return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'success' }] };
		} catch {
			return { cli: 'codex', cliAvailable: true, target: file.path, servers: [{ server: 'para-browser', outcome: 'error', detail: CODEX_SETUP_ERROR }] };
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
