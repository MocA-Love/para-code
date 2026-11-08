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
// 対象は macOS / Linux の手元のペインと、SSH の接続先（macOS / Linux）のペイン。接続先へは、接続先のホームと
// 確かめの口（IParadisClaudeModRemoteHost）を渡したものが写す（paradisRemoteAgentHooks.contribution.ts）。
// Windows は入れていない（NOTES.md「Claude Mods」）。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqual, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { PARADIS_AGENT_HOOKS_ENABLED_SETTING, paradisAgentHooksEnabled } from '../../agentBrowser/common/paradisAgentHooks.js';
import { PARADIS_CLAUDE_MOD_ENABLED_SETTING, PARADIS_CLAUDE_MOD_INSTALL_SEGMENTS, paradisClaudeManagedSettingsPaths, PARADIS_CLAUDE_MOD_SOURCE_SEGMENTS, PARADIS_CLAUDE_DRAFT_MOD_SEGMENT, PARADIS_CLAUDE_MOD_STALE_INSTALL_MS, paradisClaudeConfigDirProvider, paradisClaudeVersionProvider, paradisClaudeManagedSettingsBlockMods, paradisClaudeModShipsFile, paradisSupportsClaudeDraftMod, paradisOnDidSetClaudeConfigDirProvider } from '../common/paradisClaudeMod.js';

/** 使っている指紋を記録し直す間隔（掃除は 30 日使われていないものが対象）。 */
const MARK_USED_INTERVAL_MS = 24 * 60 * 60_000;

/** managed 設定を読み直す間隔（組織の設定やサーバーからの方針は後から届くことがある）。 */
const POLICY_RECHECK_MS = 5 * 60_000;

interface IPolicyCandidates {
	readonly files: readonly { readonly uri: URI; readonly format: 'json' | 'plist' }[];
	readonly dropInDirectories: readonly URI[];
}

/** managed 設定を探す場所（手元）。 */
function managedSettingsCandidates(home: URI, claudeConfigDirs: readonly URI[]): IPolicyCandidates {
	const { files, dropInDirectories } = paradisClaudeManagedSettingsPaths(isMacintosh, home.path, claudeConfigDirs.map(directory => directory.path));
	return {
		files: files.map(file => ({ uri: URI.file(file.path), format: file.format })),
		dropInDirectories: dropInDirectories.map(directory => URI.file(directory)),
	};
}

/**
 * SSH の接続先へ写すときの、接続先の確かめの口（REH の paradisRemoteClaudeMod.server.ts）。手元の managed 設定と
 * `claude --version` の代わりに使う。接続先の Claude Code は接続先の方針と版で動くため。
 */
export interface IParadisClaudeModRemoteHost {
	/** 接続先の managed 設定が mod を禁じていそうか（聞けない・接続先が macOS / Linux でないときも true）。 */
	blockedByPolicy(): Promise<boolean>;
	/** 接続先の `claude --version` の出力（確かめられなければ undefined）。 */
	claudeVersion(): Promise<string | undefined>;
}

/** 準備に失敗したとき、次のペインで準備をやり直すまでの間隔（接続直後の揺れで SSH の接続先へ写せなかったときなど）。 */
const PREPARE_RETRY_MS = 60_000;

export class ParadisClaudeModEnvironment extends Disposable {

	/** 写し終えた mod のフォルダ（使ってよいときだけ入る）。 */
	private installedDirectory: string | undefined;
	private installedTarget: URI | undefined;
	private blockedByPolicy = true;
	private policyCheckedAt = 0;
	private policyCheck: Promise<void> | undefined;
	/** 方針の確かめの世代。設定フォルダを教わるたびに進め、古い世代の結果は使わずにやり直す。 */
	private policyGeneration = 0;
	private installRoot: URI | undefined;
	private lastMarkedAt = 0;
	/** 写した mod に入力欄の mod（`draft/`）が入っているか。 */
	private hasDraftMod = false;
	/** shared process が確かめた Claude Code が入力欄の mod を読める版か（確かめられないうちは false）。 */
	private draftSupported = false;
	private draftCheckedAt = 0;
	private draftCheck: Promise<void> | undefined;
	/** 準備（やり直しているならそのやり直し）が済んだら解決する（テストと、準備の失敗を記録するため）。 */
	get ready(): Promise<void> {
		return this.preparing;
	}
	private preparing: Promise<void>;
	private readonly now: () => number;
	/** SSH の接続先へ写すときの確かめの口（手元なら undefined）。 */
	private readonly remote: IParadisClaudeModRemoteHost | undefined;
	/** 準備に失敗した時刻（やり直しの間隔を数える）。 */
	private prepareFailedAt: number | undefined;

	constructor(
		/** 同梱の mod がある appRoot。手元で動く desktop のウィンドウだけが渡す。 */
		private readonly appRoot: string | undefined,
		private readonly userHome: () => Promise<URI>,
		/**
		 * テスト用: いまの時刻と、動いている OS が Windows か。`remote` は SSH の接続先へ写すとき（`userHome` は接続先の
		 * ホームを返す）。方針と版は接続先に聞く。
		 */
		options: { readonly now?: () => number; readonly windows?: boolean; readonly remote?: IParadisClaudeModRemoteHost } | undefined,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.now = options?.now ?? Date.now;
		this.remote = options?.remote;
		// 手元が Windows なら、接続先へも写さない（手元の Windows は対象外。接続先が Windows かは接続先が確かめ、
		// そのときは blockedByPolicy が true になる）
		const windows = options?.windows ?? isWindows;
		// shared process から Claude Code の設定フォルダ（CLAUDE_CONFIG_DIR）を教わったら、方針を読み直す（手元だけ）
		if (this.remote === undefined) {
			this._register(toDisposable(paradisOnDidSetClaudeConfigDirProvider(() => {
				// 確かめ直すまでは渡さない（教わった設定フォルダで禁じられているかもしれない）
				this.blockedByPolicy = true;
				this.policyCheckedAt = 0;
				this.policyGeneration++;
				void this.checkPolicy();
			})));
		}
		this.preparing = this.appRoot !== undefined && !windows ? this.tryPrepare() : Promise.resolve();
	}

	private tryPrepare(): Promise<void> {
		return this.prepare().catch(error => {
			this.prepareFailedAt = this.now();
			this.logService.warn(`[ParadisClaudeMod] could not prepare the Claude Code mod${this.remote !== undefined ? ' on the SSH host' : ''}; Claude Code runs without it (will retry)`, error);
		});
	}

	/**
	 * ペインへ渡す mod のフォルダ。準備が済んでいない・設定でオフ・組織の方針が禁じているときは undefined
	 * （そのペインは mod 無しで今までどおり動く）。
	 */
	pluginDirectory(): string | undefined {
		if (this.installedDirectory === undefined) {
			if (this.prepareFailedAt !== undefined && this.now() - this.prepareFailedAt > PREPARE_RETRY_MS) {
				// 次のペインのためにやり直す（このペインには渡さない）。失敗したら tryPrepare がまた時刻を入れる
				this.prepareFailedAt = undefined;
				this.preparing = this.tryPrepare();
			}
			return undefined;
		}
		if (this.now() - this.policyCheckedAt > POLICY_RECHECK_MS) {
			// 次のペインのために読み直す（このペインは前回の結果で決める）
			void this.checkPolicy();
		}
		if (this.installRoot !== undefined && this.installedTarget !== undefined && this.now() - this.lastMarkedAt > MARK_USED_INTERVAL_MS) {
			// 長く動かし続けている Para Code でも、使っている指紋が掃除されないように 1 日 1 回記録する
			void this.markUsed(this.installRoot, this.installedTarget);
		}
		if (this.blockedByPolicy
			|| !paradisAgentHooksEnabled(this.configurationService.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING))
			|| this.configurationService.getValue(PARADIS_CLAUDE_MOD_ENABLED_SETTING) === false) {
			return undefined;
		}
		return this.installedDirectory;
	}

	/**
	 * ペインへ渡す入力欄の mod のフォルダ（{@link pluginDirectory} の中の `draft/`）。本体を渡さないとき、写した mod に無いとき、
	 * Claude Code が読めない版（2.1.300 より前。知らないイベント名の mod は読み込みに失敗して画面に断りが出る）か版を
	 * 確かめられていないときは undefined。版は 5 分ごとに確かめ直す（その間に Claude Code を下げると断りが出うる）。
	 */
	draftPluginDirectory(): string | undefined {
		const directory = this.pluginDirectory();
		if (directory === undefined || !this.hasDraftMod) {
			return undefined;
		}
		if (this.now() - this.draftCheckedAt > POLICY_RECHECK_MS) {
			void this.checkDraftSupport();
		}
		return this.draftSupported ? `${directory}/${PARADIS_CLAUDE_DRAFT_MOD_SEGMENT}` : undefined;
	}

	private checkDraftSupport(): Promise<void> {
		const remote = this.remote;
		const provider = remote !== undefined ? () => remote.claudeVersion() : paradisClaudeVersionProvider();
		if (provider === undefined) {
			// 口が入る前（起動直後）。次のペインでまた確かめる
			return Promise.resolve();
		}
		this.draftCheck ??= (async () => {
			try {
				this.draftSupported = paradisSupportsClaudeDraftMod(await provider());
			} catch {
				this.draftSupported = false;
			} finally {
				this.draftCheckedAt = this.now();
				this.draftCheck = undefined;
			}
		})();
		return this.draftCheck;
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
		if (this.remote !== undefined && this.blockedByPolicy) {
			// 接続先の方針が禁じている・接続先が macOS / Linux でない・聞けない（古い REH）。接続先に mod のファイルを
			// 置かない。方針は後から変わりうるので、次のペインでまた確かめる（PREPARE_RETRY_MS ごと）
			this.prepareFailedAt = this.now();
			return;
		}
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
				await this.replaceFile(uri, file.content);
			}
		}
		// 接続先の URI（vscode-remote）の fsPath は手元の OS の流儀になりうるので、接続先は path（POSIX）を渡す
		this.installedDirectory = target.scheme === Schemas.file ? target.fsPath : target.path;
		this.installedTarget = target;
		this.installRoot = installRoot;
		this.hasDraftMod = files.some(file => file.path === `${PARADIS_CLAUDE_DRAFT_MOD_SEGMENT}/hooks/hooks.json`);
		if (this.hasDraftMod) {
			await this.checkDraftSupport();
		}
		await this.markUsed(installRoot, target);
		this.logService.info(`[ParadisClaudeMod] the Claude Code mod is ready at ${target.fsPath}${this.blockedByPolicy ? ' (not loaded: managed settings forbid plugin folders)' : ''}`);
		await this.removeStaleInstalls(installRoot, target);
	}

	/**
	 * 隣の一時名へ書いてから置き換える。同じ接続先へ 2 つの窓が同時に初めて写しても、claude が書きかけの
	 * ファイルを読まないようにする（接続先の provider が atomic な書き込みを持たない場合もあるので move で置き換える）。
	 */
	private async replaceFile(uri: URI, content: VSBuffer): Promise<void> {
		const temporary = uri.with({ path: `${uri.path}.${generateUuid()}.paratmp` });
		try {
			await this.fileService.writeFile(temporary, content);
			await this.fileService.move(temporary, uri, true);
		} catch (error) {
			await this.fileService.del(temporary).catch(() => undefined);
			throw error;
		}
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
		if (this.remote !== undefined) {
			return this.remote.blockedByPolicy();
		}
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
