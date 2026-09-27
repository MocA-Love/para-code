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
//  - 調べたときの中身の指紋（SHA-256）を画面側が確認のあとに返し、書く直前の中身と比べる。
//    利用者が確かめた後に中身が変わっていたら書かない（新規のはずの場所は排他作成）
//  - 置き場所の `skills/` `para-code/` と `SKILL.md` のどれかがシンボリックリンク（またはファイルでない）なら
//    触らない（dotfiles で管理しているスキルをリンクの先まで書き換えないため）

import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { PARADIS_AGENT_IDE_SKILL_CONTENT } from '../common/paradisAgentIdeGuide.js';
import { IParadisAgentIdeSkillInspection, IParadisAgentIdeSkillInstallRequest, IParadisAgentIdeSkillInstallResult, IParadisAgentIdeSkillTarget, ParadisAgentIdeSkillState } from '../common/paradisAgentIdeSkillPlan.js';

/** スキルの名前（ディレクトリ名）。 */
const SKILL_DIRECTORY = 'para-code';

function absoluteOr(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed && isAbsolute(trimmed) ? trimmed : fallback;
}

/**
 * 設置先を決める。
 * - Claude Code: `$CLAUDE_CONFIG_DIR/skills/para-code/SKILL.md`（既定 `~/.claude/skills/...`）
 * - Codex: `~/.agents/skills/para-code/SKILL.md`（codex-cli 0.155.1 の既定の利用者スキルの置き場所。
 *   `$CODEX_HOME/skills` は非推奨として読まれるだけ。`codex-rs/ext/skills/src/host_roots.rs` で確認）
 *
 * `env` はログインシェルの環境（スキル管理画面が `process.shellEnv()` で読むのと同じもの）を渡す。
 * GUI から起動した shared process の `process.env` には、シェルの rc だけで export した
 * `CLAUDE_CONFIG_DIR` が入らないため。
 */
export function paradisAgentIdeSkillTargets(env: Readonly<Record<string, string | undefined>>, userHome: string = homedir()): readonly IParadisAgentIdeSkillTarget[] {
	return [
		{ agent: 'claude', path: join(absoluteOr(env.CLAUDE_CONFIG_DIR, join(userHome, '.claude')), 'skills', SKILL_DIRECTORY, 'SKILL.md') },
		{ agent: 'codex', path: join(userHome, '.agents', 'skills', SKILL_DIRECTORY, 'SKILL.md') },
	];
}

/** 中身の指紋。画面側との往復で「確かめたときと同じか」を比べるのに使う。 */
export function paradisAgentIdeSkillFingerprint(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

async function isSymlinkOrNotDirectory(path: string): Promise<boolean> {
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

async function inspectPath(path: string, content: string): Promise<{ readonly state: ParadisAgentIdeSkillState; readonly fingerprint?: string }> {
	// `skills/` と `para-code/` がリンクなら、その先へ書くことになるので触らない
	const skillDirectory = dirname(path);
	if (await isSymlinkOrNotDirectory(skillDirectory) || await isSymlinkOrNotDirectory(dirname(skillDirectory))) {
		return { state: 'notAFile' };
	}
	let stat;
	try {
		stat = await fs.lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { state: 'missing' };
		}
		throw error;
	}
	if (!stat.isFile()) {
		return { state: 'notAFile' };
	}
	const current = await fs.readFile(path, 'utf8');
	return { state: current === content ? 'same' : 'different', fingerprint: paradisAgentIdeSkillFingerprint(current) };
}

export async function paradisInspectAgentIdeSkills(targets: readonly IParadisAgentIdeSkillTarget[], content: string = PARADIS_AGENT_IDE_SKILL_CONTENT): Promise<IParadisAgentIdeSkillInspection[]> {
	return Promise.all(targets.map(async target => {
		try {
			const inspected = await inspectPath(target.path, content);
			return { ...target, state: inspected.state, ...(inspected.fingerprint !== undefined ? { fingerprint: inspected.fingerprint } : {}) };
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
			const inspected = await inspectPath(target.path, content);
			if (inspected.state === 'same') {
				results.push({ ...target, outcome: 'unchanged' });
				continue;
			}
			if (inspected.state === 'notAFile') {
				results.push({ ...target, outcome: 'skipped', detail: 'not a regular file, or a folder on the way is a symbolic link' });
				continue;
			}
			if (inspected.state === 'different') {
				if (!request.overwrite) {
					results.push({ ...target, outcome: 'skipped', detail: 'different file exists' });
					continue;
				}
				// 利用者が確かめたときの中身から変わっていたら、確かめていない中身を上書きしない
				if (request.expectedFingerprint === undefined || request.expectedFingerprint !== inspected.fingerprint) {
					results.push({ ...target, outcome: 'skipped', detail: 'the file changed after it was checked' });
					continue;
				}
			}
			await fs.mkdir(dirname(target.path), { recursive: true });
			if (inspected.state === 'missing') {
				// 無いはずのファイルは排他作成にする（確かめた後に別のものが置かれていたら上書きしない）
				await fs.writeFile(target.path, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
				results.push({ ...target, outcome: 'installed' });
				continue;
			}
			// 上書きは同じフォルダの一時ファイルへ書いてから rename で差し替える。その場へ `w` で書くと、
			// 確かめた後に SKILL.md がシンボリックリンクへ差し替えられていた場合にリンクの先へ書いてしまう
			// （rename はリンクそのものを置き換え、先はたどらない）
			const temporary = join(dirname(target.path), `.SKILL.md.paradis-${randomUUID()}.tmp`);
			try {
				await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
				const recheck = await inspectPath(target.path, content);
				if (recheck.state !== 'different' || recheck.fingerprint !== inspected.fingerprint) {
					results.push({ ...target, outcome: 'skipped', detail: 'the file changed after it was checked' });
					continue;
				}
				await fs.rename(temporary, target.path);
			} finally {
				await fs.rm(temporary, { force: true });
			}
			results.push({ ...target, outcome: 'overwritten' });
		} catch (error) {
			results.push({ ...target, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

/** 画面側から呼ぶチャネル。`inspect` と `install` だけ。パスは受け取らない。 */
export class ParadisAgentIdeSkillsChannel implements IServerChannel {

	constructor(private readonly targets: () => Promise<readonly IParadisAgentIdeSkillTarget[]>) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'inspect':
				return await paradisInspectAgentIdeSkills(await this.targets()) as T;
			case 'install': {
				const raw = Array.isArray(arg) ? arg[0] : undefined;
				const requests = Array.isArray(raw) ? raw.filter((item): item is IParadisAgentIdeSkillInstallRequest =>
					!!item && typeof item === 'object'
					&& ((item as IParadisAgentIdeSkillInstallRequest).agent === 'claude' || (item as IParadisAgentIdeSkillInstallRequest).agent === 'codex')
					&& typeof (item as IParadisAgentIdeSkillInstallRequest).overwrite === 'boolean'
					&& ((item as IParadisAgentIdeSkillInstallRequest).expectedFingerprint === undefined || typeof (item as IParadisAgentIdeSkillInstallRequest).expectedFingerprint === 'string')) : [];
				return await paradisInstallAgentIdeSkills(await this.targets(), requests) as T;
			}
		}
		throw new Error(`Method not found: ${command}`);
	}
}
