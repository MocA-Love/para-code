/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code のスキルファイル（SKILL.md）を Claude Code と Codex のスキルの置き場所へ設置する（O4、Q79）。
// 設置は「設定 (Para Code)」のボタンを押したときだけ行う（自動では置かない）。書き込み先は
// 利用者の本物のホームなので、次を守る。
//  - 書き込み先はここで決める。画面側（IPC の相手）からパスを受け取らない
//  - 既にあるファイルの中身が違えば、画面側が利用者に確かめてから `overwrite` を付けて呼ぶ。
//    確かめた後に中身が変わっていても、呼び出し時にもう一度比べるので黙って上書きしない
//  - ファイルでないもの（シンボリックリンク・ディレクトリ）は触らない（dotfiles で管理している
//    スキルをリンクの先まで書き換えないため）

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from '../../../../base/common/path.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { paradisClaudeConfigDir } from '../../agentBrowser/node/paradisAgentHome.js';
import { PARADIS_AGENT_IDE_SKILL_CONTENT } from '../common/paradisAgentIdeGuide.js';
import { IParadisAgentIdeSkillInspection, IParadisAgentIdeSkillInstallRequest, IParadisAgentIdeSkillInstallResult, IParadisAgentIdeSkillTarget, ParadisAgentIdeSkillState } from '../common/paradisAgentIdeSkillPlan.js';

/** スキルの名前（ディレクトリ名）。 */
const SKILL_DIRECTORY = 'para-code';

/**
 * 設置先を決める。
 * - Claude Code: `$CLAUDE_CONFIG_DIR/skills/para-code/SKILL.md`（既定 `~/.claude/skills/...`）
 * - Codex: `~/.agents/skills/para-code/SKILL.md`（codex-cli 0.155.1 の既定の利用者スキルの置き場所。
 *   `$CODEX_HOME/skills` は非推奨として読まれるだけ。`codex-rs/ext/skills/src/host_roots.rs` で確認）
 */
export function paradisAgentIdeSkillTargets(homes: { readonly claudeConfigDir: string; readonly userHome: string } = { claudeConfigDir: paradisClaudeConfigDir(), userHome: homedir() }): readonly IParadisAgentIdeSkillTarget[] {
	return [
		{ agent: 'claude', path: join(homes.claudeConfigDir, 'skills', SKILL_DIRECTORY, 'SKILL.md') },
		{ agent: 'codex', path: join(homes.userHome, '.agents', 'skills', SKILL_DIRECTORY, 'SKILL.md') },
	];
}

async function inspectPath(path: string, content: string): Promise<ParadisAgentIdeSkillState> {
	let stat;
	try {
		stat = await fs.lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return 'missing';
		}
		throw error;
	}
	if (!stat.isFile()) {
		return 'notAFile';
	}
	const current = await fs.readFile(path, 'utf8');
	return current === content ? 'same' : 'different';
}

export async function paradisInspectAgentIdeSkills(targets: readonly IParadisAgentIdeSkillTarget[], content: string = PARADIS_AGENT_IDE_SKILL_CONTENT): Promise<IParadisAgentIdeSkillInspection[]> {
	return Promise.all(targets.map(async target => {
		try {
			return { ...target, state: await inspectPath(target.path, content) };
		} catch {
			// 読めないものは「ファイルでない」と同じく触らない側に倒す
			return { ...target, state: 'notAFile' as const };
		}
	}));
}

export async function paradisInstallAgentIdeSkills(
	targets: readonly IParadisAgentIdeSkillTarget[],
	requests: readonly IParadisAgentIdeSkillInstallRequest[],
	content: string = PARADIS_AGENT_IDE_SKILL_CONTENT,
): Promise<IParadisAgentIdeSkillInstallResult[]> {
	const results: IParadisAgentIdeSkillInstallResult[] = [];
	for (const request of requests) {
		const target = targets.find(candidate => candidate.agent === request.agent);
		if (!target) {
			continue;
		}
		try {
			const state = await inspectPath(target.path, content);
			if (state === 'same') {
				results.push({ ...target, outcome: 'unchanged' });
				continue;
			}
			if (state === 'notAFile') {
				results.push({ ...target, outcome: 'skipped', detail: 'not a regular file' });
				continue;
			}
			if (state === 'different' && !request.overwrite) {
				results.push({ ...target, outcome: 'skipped', detail: 'different file exists' });
				continue;
			}
			await fs.mkdir(dirname(target.path), { recursive: true });
			// 無いはずのファイルは排他作成にする（確かめた後に別のものが置かれていたら上書きしない）
			await fs.writeFile(target.path, content, { encoding: 'utf8', mode: 0o644, flag: state === 'missing' ? 'wx' : 'w' });
			results.push({ ...target, outcome: state === 'missing' ? 'installed' : 'overwritten' });
		} catch (error) {
			results.push({ ...target, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

/** 画面側から呼ぶチャネル。`inspect` と `install` だけ。パスは受け取らない。 */
export class ParadisAgentIdeSkillsChannel implements IServerChannel {

	constructor(private readonly targets: () => readonly IParadisAgentIdeSkillTarget[] = () => paradisAgentIdeSkillTargets()) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'inspect':
				return await paradisInspectAgentIdeSkills(this.targets()) as T;
			case 'install': {
				const raw = Array.isArray(arg) ? arg[0] : undefined;
				const requests = Array.isArray(raw) ? raw.filter((item): item is IParadisAgentIdeSkillInstallRequest =>
					!!item && typeof item === 'object'
					&& ((item as IParadisAgentIdeSkillInstallRequest).agent === 'claude' || (item as IParadisAgentIdeSkillInstallRequest).agent === 'codex')
					&& typeof (item as IParadisAgentIdeSkillInstallRequest).overwrite === 'boolean') : [];
				return await paradisInstallAgentIdeSkills(this.targets(), requests) as T;
			}
		}
		throw new Error(`Method not found: ${command}`);
	}
}
