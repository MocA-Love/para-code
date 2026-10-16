// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ITaskBoardFlow } from '@engine/paradisTaskBoard.js';
import { mergeTaskBoardFlows, parseTaskBoardFlowFile, serializeTaskBoardFlow, TASK_BOARD_DEFAULT_FLOW, type ITaskBoardFlowProblem } from '@engine/paradisTaskBoardFlow.js';

/*
 * フロー定義ファイルの読み書き（Q346 A）。
 *   共通: <repo>/.para-code/paracode.json        （無ければ旧 <repo>/.paracode.json を読む）
 *   個人: <repo>/.para-code/<login>/workflows.json
 * 書き込みは常に新しい場所へ行い、既存のほかのキー（setup / teardown など）は残す。
 */

export interface IFlowFiles {
	readonly team: string;
	readonly legacy: string;
	readonly personal: string | undefined;
}

export function flowFiles(repoPath: string, login: string | undefined): IFlowFiles {
	const safeLogin = login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : undefined;
	return {
		team: path.join(repoPath, '.para-code', 'paracode.json'),
		legacy: path.join(repoPath, '.paracode.json'),
		personal: safeLogin ? path.join(repoPath, '.para-code', safeLogin, 'workflows.json') : undefined,
	};
}

async function readJson(file: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw new Error(`${file}: ${(err as Error).message}`);
	}
}

export interface ILoadedFlows {
	readonly flows: ITaskBoardFlow[];
	readonly active?: string;
	readonly problems: ITaskBoardFlowProblem[];
	readonly sources: string[];
}

export async function loadFlows(repoPath: string | undefined, login: string | undefined): Promise<ILoadedFlows> {
	if (!repoPath) {
		return { flows: [TASK_BOARD_DEFAULT_FLOW], problems: [], sources: [] };
	}
	const files = flowFiles(repoPath, login);
	const problems: ITaskBoardFlowProblem[] = [];
	const sources: string[] = [];
	let team: ITaskBoardFlow[] = [];
	let personal: ITaskBoardFlow[] = [];
	let active: string | undefined;
	const teamRaw = await readJson(files.team).catch(err => { problems.push({ path: files.team, message: String(err.message) }); return undefined; });
	const teamSource = teamRaw !== undefined ? files.team : files.legacy;
	const teamData = teamRaw ?? await readJson(files.legacy).catch(err => { problems.push({ path: files.legacy, message: String(err.message) }); return undefined; });
	if (teamData !== undefined) {
		const parsed = parseTaskBoardFlowFile(teamData, 'team', path.relative(repoPath, teamSource));
		team = parsed.flows;
		problems.push(...parsed.problems);
		if (team.length) {
			sources.push(teamSource);
		}
	}
	if (files.personal) {
		const raw = await readJson(files.personal).catch(err => { problems.push({ path: files.personal!, message: String(err.message) }); return undefined; });
		if (raw !== undefined) {
			const parsed = parseTaskBoardFlowFile(raw, 'personal', path.relative(repoPath, files.personal));
			personal = parsed.flows;
			problems.push(...parsed.problems);
			sources.push(files.personal);
			const rec = raw as { active?: unknown };
			if (typeof rec.active === 'string') {
				active = rec.active;
			}
		}
	}
	return { flows: mergeTaskBoardFlows([TASK_BOARD_DEFAULT_FLOW], team, personal), active, problems, sources };
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data, null, '\t') + '\n', 'utf8');
	await fs.rename(tmp, file);
}

/** フローを保存し、保存したファイルの絶対パスを返す。 */
export async function saveFlow(repoPath: string, login: string | undefined, flow: ITaskBoardFlow, scope: 'team' | 'personal', active?: string): Promise<string> {
	const files = flowFiles(repoPath, login);
	const target = scope === 'personal' ? files.personal : files.team;
	if (!target) {
		throw new Error('GitHub login is unknown; cannot decide the personal folder');
	}
	let existing = await readJson(target);
	if (existing === undefined && scope === 'team') {
		// 旧ファイルの設定（setup / teardown など）を新しい場所へ引き継ぐ
		existing = await readJson(files.legacy);
	}
	const record = (existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}) as Record<string, unknown>;
	const list = Array.isArray(record.workflows) ? record.workflows.filter(w => !(w && typeof w === 'object' && (w as { id?: unknown }).id === flow.id)) : [];
	const serialized = serializeTaskBoardFlow(flow);
	const index = Array.isArray(record.workflows) ? record.workflows.findIndex(w => w && typeof w === 'object' && (w as { id?: unknown }).id === flow.id) : -1;
	list.splice(index >= 0 ? index : list.length, 0, serialized);
	record.workflows = list;
	if (scope === 'personal' && active) {
		record.active = active;
	}
	await writeJsonAtomic(target, record);
	return target;
}

/** 個人ファイルの「使うフロー」だけを書き換える。 */
export async function saveActiveFlow(repoPath: string, login: string | undefined, active: string): Promise<void> {
	const target = flowFiles(repoPath, login).personal;
	if (!target) {
		return;
	}
	const existing = await readJson(target);
	const record = (existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}) as Record<string, unknown>;
	record.active = active;
	await writeJsonAtomic(target, record);
}
