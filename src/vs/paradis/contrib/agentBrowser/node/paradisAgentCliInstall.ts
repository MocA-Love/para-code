/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `para` コマンドの手引き（スキル）と Codex の規則を、この PC の Claude Code と Codex の置き場所へ置く・外す
// （設定 `paradis.agentCli.enabled`。中身と決まりは `../common/paradisAgentCliSkill.ts`）。
//
// 書き込み先は利用者の本物のホームなので、次を守る。
//  - 印（PARADIS_AGENT_CLI_MANAGED_MARK）の無いファイルは上書きも削除もしない
//  - 置き場所のフォルダ（`skills/` `para-cli/` `rules/`）やファイルがシンボリックリンクなら触らない
//    （dotfiles で管理しているものをリンクの先まで書き換えない）
//  - エージェントを使っていない利用者のホームにフォルダを作らない（`~/.claude`・Codex のホームがあるときだけ置く）
//  - 書くときは同じフォルダの一時ファイルへ書いてから rename で差し替える
//  - 起動した時点でオフなら何もしない。オンからオフへ切り替わったその時だけ外す

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisAgentCliFile, PARADIS_AGENT_CLI_CODEX_RULES_CONTENT, PARADIS_AGENT_CLI_CODEX_RULES_FILE, PARADIS_AGENT_CLI_SKILL_CONTENT, PARADIS_AGENT_CLI_SKILL_DIRECTORY, paradisAgentCliFileAction } from '../common/paradisAgentCliSkill.js';

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await fs.stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 置くファイルの一覧。
 * - Claude Code: `$CLAUDE_CONFIG_DIR/skills/para-cli/SKILL.md`（既定 `~/.claude`）。そのフォルダがあるときだけ
 * - Codex のスキル: `~/.agents/skills/para-cli/SKILL.md`（Codex の利用者スキルの置き場所。`$CODEX_HOME/skills` は
 *   非推奨として読まれるだけ。`../../agentIde/node/paradisAgentIdeSkills.ts` と同じ）。Codex のホームが 1 つでもあるときだけ
 * - Codex の規則: 各ホームの `rules/para-code.rules`
 *
 * @param env ログインシェルの環境（GUI から起動した shared process の `process.env` には、シェルの rc だけで export した
 *   `CLAUDE_CONFIG_DIR` が入らない）
 * @param codexHomes Para Code が設定を書いてよい Codex のホーム（`paradisCodexConfigHomes()`）
 */
export async function paradisAgentCliFiles(env: Readonly<Record<string, string | undefined>>, codexHomes: readonly string[], userHome: string = homedir()): Promise<IParadisAgentCliFile[]> {
	const files: IParadisAgentCliFile[] = [];
	const configured = env.CLAUDE_CONFIG_DIR?.trim();
	const claudeHome = configured && isAbsolute(configured) ? configured : join(userHome, '.claude');
	if (await isDirectory(claudeHome)) {
		files.push({ kind: 'claude-skill', path: join(claudeHome, 'skills', PARADIS_AGENT_CLI_SKILL_DIRECTORY, 'SKILL.md'), content: PARADIS_AGENT_CLI_SKILL_CONTENT });
	}
	const existingCodexHomes: string[] = [];
	for (const home of codexHomes) {
		if (await isDirectory(home)) {
			existingCodexHomes.push(home);
		}
	}
	if (existingCodexHomes.length > 0) {
		files.push({ kind: 'codex-skill', path: join(userHome, '.agents', 'skills', PARADIS_AGENT_CLI_SKILL_DIRECTORY, 'SKILL.md'), content: PARADIS_AGENT_CLI_SKILL_CONTENT });
	}
	for (const home of existingCodexHomes) {
		files.push({ kind: 'codex-rules', path: join(home, 'rules', PARADIS_AGENT_CLI_CODEX_RULES_FILE), content: PARADIS_AGENT_CLI_CODEX_RULES_CONTENT });
	}
	return files;
}

export type ParadisAgentCliFileOutcome = 'written' | 'removed' | 'unchanged' | 'skipped' | 'failed';

export interface IParadisAgentCliFileResult {
	readonly kind: IParadisAgentCliFile['kind'];
	readonly path: string;
	readonly outcome: ParadisAgentCliFileOutcome;
	readonly detail?: string;
}

/** フォルダがリンク・フォルダ以外なら true（無いのは false）。 */
async function isLinkOrNotDirectory(path: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(path);
		return stat.isSymbolicLink() || !stat.isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function syncFile(file: IParadisAgentCliFile, enabled: boolean): Promise<IParadisAgentCliFileResult> {
	const folder = dirname(file.path);
	// スキルは `skills/para-cli/`、規則は `rules/` の 2 段（規則では Codex のホームまで）を見る
	if (await isLinkOrNotDirectory(folder) || await isLinkOrNotDirectory(dirname(folder))) {
		return { kind: file.kind, path: file.path, outcome: 'skipped', detail: 'a folder on the way is a symbolic link or not a folder' };
	}
	let existing: string | undefined;
	try {
		const stat = await fs.lstat(file.path);
		if (!stat.isFile()) {
			return { kind: file.kind, path: file.path, outcome: 'skipped', detail: 'not a regular file' };
		}
		existing = await fs.readFile(file.path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	const action = paradisAgentCliFileAction(existing, enabled ? file.content : undefined);
	if (action === 'keep') {
		// 中身が同じ・外すものが無い・利用者のファイル
		return { kind: file.kind, path: file.path, outcome: existing !== undefined && existing !== file.content && enabled ? 'skipped' : 'unchanged', ...(existing !== undefined && existing !== file.content && enabled ? { detail: 'a file without the Para Code mark is there' } : {}) };
	}
	if (action === 'remove') {
		await fs.rm(file.path, { force: true });
		if (file.kind !== 'codex-rules') {
			// 自分のスキルのフォルダが空になったら消す（ほかのファイルがあれば残る）
			await fs.rmdir(folder).catch(() => undefined);
		}
		return { kind: file.kind, path: file.path, outcome: 'removed' };
	}
	await fs.mkdir(folder, { recursive: true });
	if (existing === undefined) {
		// 無いはずの場所は排他作成（見た後に別のものが置かれていたら上書きしない）
		await fs.writeFile(file.path, file.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
		return { kind: file.kind, path: file.path, outcome: 'written' };
	}
	const temporary = join(folder, `.${PARADIS_AGENT_CLI_SKILL_DIRECTORY}-${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, file.content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
		await fs.rename(temporary, file.path);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	return { kind: file.kind, path: file.path, outcome: 'written' };
}

/** 一覧のファイルを置く（`enabled`）か、自分が置いたものを外す。1 つの失敗でほかを止めない。 */
export async function paradisSyncAgentCliFiles(files: readonly IParadisAgentCliFile[], enabled: boolean): Promise<IParadisAgentCliFileResult[]> {
	const results: IParadisAgentCliFileResult[] = [];
	for (const file of files) {
		try {
			results.push(await syncFile(file, enabled));
		} catch (error) {
			results.push({ kind: file.kind, path: file.path, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

export interface IParadisAgentCliAutoInstallOptions {
	readonly isEnabled: () => boolean;
	/** 設定が変わったかもしれないときに発火する（値が同じでもよい）。 */
	readonly onDidChangeEnabled: Event<void>;
	/** 置き場所が増えたかもしれないとき（Codex のホームが増えた）。 */
	readonly onDidChangeTargets: Event<void>;
	/** 今の置き場所の一覧。 */
	readonly files: () => Promise<readonly IParadisAgentCliFile[]>;
	readonly logService: ILogService;
}

/**
 * 設定に合わせて、手引きと規則を置く・外す。起動時にオンなら置き、オフなら何もしない（外しもしない。同じ PC の
 * 別の Para Code が置いたものを消さないため。hook の自動設置と同じ決まり）。オンからオフへ切り替わったら外す。
 */
export class ParadisAgentCliAutoInstall extends Disposable {

	private installed = false;
	/** 切り替えを 1 つずつ順に処理する（置くのと外すのが交差しない）。 */
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly options: IParadisAgentCliAutoInstallOptions) {
		super();
		this._register(options.onDidChangeEnabled(() => this.schedule(false)));
		this._register(options.onDidChangeTargets(() => this.schedule(true)));
		if (options.isEnabled()) {
			this.schedule(true);
		}
	}

	/** 待っている切り替えがすべて済むまで待つ（テスト用）。 */
	whenIdle(): Promise<void> {
		return this.queue;
	}

	/** @param refresh 設定が同じでも置き直す（起動時・置き場所が増えたとき） */
	private schedule(refresh: boolean): void {
		const run = () => this.apply(refresh);
		this.queue = this.queue.then(run, run);
	}

	private async apply(refresh: boolean): Promise<void> {
		if (this._store.isDisposed) {
			return;
		}
		const wanted = this.options.isEnabled();
		if (wanted === this.installed && !(wanted && refresh)) {
			return;
		}
		this.installed = wanted;
		try {
			const results = await paradisSyncAgentCliFiles(await this.options.files(), wanted);
			const changed = results.filter(result => result.outcome !== 'unchanged');
			if (changed.length > 0) {
				this.options.logService.info(`[ParadisAgentCli] ${wanted ? 'installed' : 'removed'} the para skill and the Codex rule: ${changed.map(result => `${result.kind} ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`).join(', ')}`);
			}
		} catch (error) {
			this.options.logService.warn('[ParadisAgentCli] could not update the para skill and the Codex rule', error);
		}
	}
}
