/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 手元のペインで動く Claude Code に Para Code の mod を読ませる準備（ペインの env を組み立てる
// paradisPaneTokenService.ts から使う）。
//
// 1. 同梱の mod（appRoot/resources/paradis/claude-mod）を `~/.para-code/claude-mod/<内容の指紋>/` へ写す。
//    Claude Code は読み込んだ mod のフォルダへ型定義と tsconfig を書き足すので、アプリの中（署名済みの
//    バンドル）を直接指すと署名を壊す。指紋のフォルダは一度作ったら書き換えない（動いている Claude Code が
//    保存を検知して読み直さないように。版の違う Para Code が同じ PC にあっても互いに上書きしない）。
//    30 日以上使われていない別の指紋のフォルダは片付ける。
// 2. Claude Code の managed 設定（組織の方針）が mod を禁じていないか確かめる。`disableSideloadFlags` の
//    下で `CLAUDE_CODE_PLUGIN_DIRS` を渡すと claude が起動しなくなるため、立っていそうなら渡さない。
//
// env の組み立ては PTY 起動の直前に同期で走るので、準備は先に非同期で済ませておき、済んでいない間に
// 開いたペインには渡さない（そのペインは今までどおり hook・transcript・キーで動く）。
//
// 対象は macOS / Linux の手元のペインだけ。SSH の接続先と Windows は入れていない（NOTES.md「Claude Mods」）。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { isEqual, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_AGENT_HOOKS_ENABLED_SETTING, paradisAgentHooksEnabled } from '../../agentBrowser/common/paradisAgentHooks.js';
import { PARADIS_CLAUDE_MOD_ENABLED_SETTING, PARADIS_CLAUDE_MOD_INSTALL_SEGMENTS, PARADIS_CLAUDE_MOD_SOURCE_SEGMENTS, PARADIS_CLAUDE_MOD_STALE_INSTALL_MS, paradisClaudeConfigDirProvider, paradisClaudeManagedSettingsBlockMods, paradisClaudeModShipsFile, paradisOnDidSetClaudeConfigDirProvider } from '../common/paradisClaudeMod.js';

/** 使っている指紋を記録し直す間隔（掃除は 30 日使われていないものが対象）。 */
const MARK_USED_INTERVAL_MS = 24 * 60 * 60_000;

/** managed 設定を読み直す間隔（組織の設定やサーバーからの方針は後から届くことがある）。 */
const POLICY_RECHECK_MS = 5 * 60_000;

interface IPolicyCandidates {
	readonly files: readonly { readonly uri: URI; readonly format: 'json' | 'plist' }[];
	readonly dropInDirectories: readonly URI[];
}

/** managed 設定を探す場所（Claude Code 2.1.288 が読む場所）。`remote-settings.json` は Claude Code の設定フォルダごとに 1 つ。 */
function managedSettingsCandidates(home: URI, claudeConfigDirs: readonly URI[]): IPolicyCandidates {
	const user = home.path.split('/').filter(segment => segment.length > 0).pop();
	const remoteSettings = claudeConfigDirs.map(directory => ({ uri: joinPath(directory, 'remote-settings.json'), format: 'json' as const }));
	if (isMacintosh) {
		const base = URI.file('/Library/Application Support/ClaudeCode');
		return {
			files: [
				{ uri: joinPath(base, 'managed-settings.json'), format: 'json' },
				{ uri: URI.file('/Library/Managed Preferences/com.anthropic.claudecode.plist'), format: 'plist' },
				...(user !== undefined ? [{ uri: URI.file(`/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`), format: 'plist' as const }] : []),
				...remoteSettings,
			],
			dropInDirectories: [joinPath(base, 'managed-settings.d')],
		};
	}
	const base = URI.file('/etc/claude-code');
	return {
		files: [{ uri: joinPath(base, 'managed-settings.json'), format: 'json' }, ...remoteSettings],
		dropInDirectories: [joinPath(base, 'managed-settings.d')],
	};
}

export class ParadisClaudeModEnvironment extends Disposable {

	/** 写し終えた mod のフォルダ（使ってよいときだけ入る）。 */
	private installedDirectory: string | undefined;
	private blockedByPolicy = true;
	private policyCheckedAt = 0;
	private policyCheck: Promise<void> | undefined;
	/** 方針の確かめの世代。設定フォルダを教わるたびに進め、古い世代の結果は使わずにやり直す。 */
	private policyGeneration = 0;
	private installRoot: URI | undefined;
	private lastMarkedAt = 0;
	/** 準備が済んだら解決する（テストと、準備の失敗を記録するため）。 */
	readonly ready: Promise<void>;
	private readonly now: () => number;

	constructor(
		/** 同梱の mod がある appRoot。手元で動く desktop のウィンドウだけが渡す。 */
		private readonly appRoot: string | undefined,
		private readonly userHome: () => Promise<URI>,
		/** テスト用: いまの時刻と、動いている OS が Windows か。 */
		options: { readonly now?: () => number; readonly windows?: boolean } | undefined,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.now = options?.now ?? Date.now;
		const windows = options?.windows ?? isWindows;
		// shared process から Claude Code の設定フォルダ（CLAUDE_CONFIG_DIR）を教わったら、方針を読み直す
		this._register(toDisposable(paradisOnDidSetClaudeConfigDirProvider(() => {
			// 確かめ直すまでは渡さない（教わった設定フォルダで禁じられているかもしれない）
			this.blockedByPolicy = true;
			this.policyCheckedAt = 0;
			this.policyGeneration++;
			void this.checkPolicy();
		})));
		this.ready = this.appRoot !== undefined && !windows
			? this.prepare().catch(error => this.logService.warn('[ParadisClaudeMod] could not prepare the Claude Code mod; Claude Code runs without it', error))
			: Promise.resolve();
	}

	/**
	 * ペインへ渡す mod のフォルダ。準備が済んでいない・設定でオフ・組織の方針が禁じているときは undefined
	 * （そのペインは mod 無しで今までどおり動く）。
	 */
	pluginDirectory(): string | undefined {
		if (this.installedDirectory === undefined) {
			return undefined;
		}
		if (this.now() - this.policyCheckedAt > POLICY_RECHECK_MS) {
			// 次のペインのために読み直す（このペインは前回の結果で決める）
			void this.checkPolicy();
		}
		if (this.installRoot !== undefined && this.now() - this.lastMarkedAt > MARK_USED_INTERVAL_MS) {
			// 長く動かし続けている Para Code でも、使っている指紋が掃除されないように 1 日 1 回記録する
			void this.markUsed(this.installRoot, URI.file(this.installedDirectory));
		}
		if (this.blockedByPolicy
			|| !paradisAgentHooksEnabled(this.configurationService.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING))
			|| this.configurationService.getValue(PARADIS_CLAUDE_MOD_ENABLED_SETTING) === false) {
			return undefined;
		}
		return this.installedDirectory;
	}

	/** mod のフォルダの中の写すファイル（`/` 区切りの相対パス）。同梱の glob と同じ除外（paradisClaudeModShipsFile）。 */
	private async listSourceFiles(root: URI): Promise<string[]> {
		const files: string[] = [];
		const walk = async (directory: URI, prefix: string) => {
			const stat = await this.fileService.resolve(directory);
			for (const child of stat.children ?? []) {
				const relative = `${prefix}${child.name}`;
				if (child.isDirectory) {
					await walk(child.resource, `${relative}/`);
				} else if (paradisClaudeModShipsFile(relative)) {
					files.push(relative);
				}
			}
		};
		await walk(root, '');
		return files.sort();
	}

	private async prepare(): Promise<void> {
		await this.checkPolicy();
		const appRoot = this.appRoot;
		if (appRoot === undefined) {
			return;
		}
		const source = joinPath(URI.file(appRoot), ...PARADIS_CLAUDE_MOD_SOURCE_SEGMENTS);
		const files: { readonly path: string; readonly content: VSBuffer }[] = [];
		const sha = new StringSHA1();
		for (const path of await this.listSourceFiles(source)) {
			const content = (await this.fileService.readFile(joinPath(source, ...path.split('/')))).value;
			files.push({ path, content });
			sha.update(`${path}\0${content.toString()}\0`);
		}
		if (!files.some(file => file.path === 'hooks/hooks.json')) {
			return;
		}
		const installRoot = joinPath(await this.userHome(), ...PARADIS_CLAUDE_MOD_INSTALL_SEGMENTS);
		const target = joinPath(installRoot, sha.digest().slice(0, 16));
		for (const file of files) {
			const uri = joinPath(target, ...file.path.split('/'));
			let same = false;
			try {
				same = (await this.fileService.readFile(uri)).value.toString() === file.content.toString();
			} catch {
				same = false;
			}
			if (!same) {
				await this.fileService.writeFile(uri, file.content);
			}
		}
		this.installedDirectory = target.fsPath;
		this.installRoot = installRoot;
		await this.markUsed(installRoot, target);
		this.logService.info(`[ParadisClaudeMod] the Claude Code mod is ready at ${target.fsPath}${this.blockedByPolicy ? ' (not loaded: managed settings forbid plugin folders)' : ''}`);
		await this.removeStaleInstalls(installRoot, target);
	}

	/**
	 * 今の指紋を「使った」と記録する（`<写し先>/.last-used/<指紋>` に時刻を書く）。mod のフォルダの中には書かない
	 * （Claude Code はフォルダの保存を検知して mod を読み直すので、動いているセッションを揺らさないため）。
	 */
	private async markUsed(installRoot: URI, current: URI): Promise<void> {
		this.lastMarkedAt = this.now();
		try {
			await this.fileService.writeFile(joinPath(installRoot, '.last-used', current.path.split('/').pop() ?? ''), VSBuffer.fromString(String(this.now())));
		} catch (error) {
			this.logService.trace('[ParadisClaudeMod] could not record the use of the Claude Code mod copy', error);
		}
	}

	/** 最後に使った時刻（記録が無ければフォルダの更新時刻）。 */
	private async lastUsed(installRoot: URI, name: string, folderMtime: number): Promise<number> {
		try {
			const recorded = Number((await this.fileService.readFile(joinPath(installRoot, '.last-used', name))).value.toString());
			return Number.isFinite(recorded) ? Math.max(recorded, folderMtime) : folderMtime;
		} catch {
			return folderMtime;
		}
	}

	/** 長く使われていない別の指紋のフォルダを消す（今の版が使うものと、最近使われたものは残す）。 */
	private async removeStaleInstalls(installRoot: URI, current: URI): Promise<void> {
		try {
			const stat = await this.fileService.resolve(installRoot, { resolveMetadata: true });
			for (const child of stat.children ?? []) {
				if (child.isDirectory && !isEqual(child.resource, current) && /^[0-9a-f]{16}$/.test(child.name)
					&& this.now() - await this.lastUsed(installRoot, child.name, child.mtime) > PARADIS_CLAUDE_MOD_STALE_INSTALL_MS) {
					await this.fileService.del(child.resource, { recursive: true });
					await this.fileService.del(joinPath(installRoot, '.last-used', child.name)).catch(() => undefined);
				}
			}
		} catch (error) {
			this.logService.trace('[ParadisClaudeMod] could not tidy up old copies of the Claude Code mod', error);
		}
	}

	private checkPolicy(): Promise<void> {
		if (this.policyCheck !== undefined) {
			return this.policyCheck;
		}
		const generation = this.policyGeneration;
		this.policyCheck = this.readPolicy().then(blocked => {
			if (generation !== this.policyGeneration) {
				return;
			}
			if (blocked && !this.blockedByPolicy) {
				this.logService.info('[ParadisClaudeMod] Claude Code managed settings forbid plugin folders (disableSideloadFlags); new terminals run Claude Code without the mod');
			}
			this.blockedByPolicy = blocked;
		}, () => {
			if (generation === this.policyGeneration) {
				this.blockedByPolicy = true;
			}
		}).finally(() => {
			this.policyCheck = undefined;
			if (generation !== this.policyGeneration) {
				// 確かめている間に設定フォルダを教わった。古い結果は使わず、今の世代で確かめ直す
				return this.checkPolicy();
			}
			this.policyCheckedAt = this.now();
			return undefined;
		});
		return this.policyCheck;
	}

	/** Claude Code の設定フォルダ。~/.claude と、shared process が読んでいる `CLAUDE_CONFIG_DIR`（教わっていれば）。 */
	private async claudeConfigDirs(home: URI): Promise<URI[]> {
		const directories = [joinPath(home, '.claude')];
		try {
			const configured = await paradisClaudeConfigDirProvider()?.();
			if (typeof configured === 'string' && configured.startsWith('/')) {
				const uri = URI.file(configured);
				if (!directories.some(directory => isEqual(directory, uri))) {
					directories.push(uri);
				}
			}
		} catch {
			// 教われなければ ~/.claude だけ
		}
		return directories;
	}

	private async readPolicy(): Promise<boolean> {
		const home = await this.userHome();
		const { files, dropInDirectories } = managedSettingsCandidates(home, await this.claudeConfigDirs(home));
		const candidates = [...files];
		for (const directory of dropInDirectories) {
			try {
				const stat = await this.fileService.resolve(directory);
				for (const child of stat.children ?? []) {
					if (!child.isDirectory && child.name.endsWith('.json')) {
						candidates.push({ uri: child.resource, format: 'json' });
					}
				}
			} catch {
				// 無い（ふつうは無い）
			}
		}
		for (const candidate of candidates) {
			let text: string;
			try {
				const content = (await this.fileService.readFile(candidate.uri)).value;
				// バイナリの plist でもキーの名前は ASCII のまま入っている
				text = candidate.format === 'plist' ? new TextDecoder('latin1').decode(content.buffer.subarray(0, 1_048_576)) : content.toString();
			} catch {
				continue;
			}
			if (paradisClaudeManagedSettingsBlockMods(text, candidate.format)) {
				return true;
			}
		}
		return false;
	}
}
