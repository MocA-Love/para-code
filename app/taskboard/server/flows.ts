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

/** リポジトリからの相対パス（共通・旧・個人）。 */
function relativeFlowFiles(login: string | undefined): IFlowFiles {
	const safeLogin = login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : undefined;
	return {
		team: '.para-code/paracode.json',
		legacy: '.paracode.json',
		personal: safeLogin ? `.para-code/${safeLogin}/workflows.json` : undefined,
	};
}

export function flowFiles(repoPath: string, login: string | undefined): IFlowFiles {
	const rel = relativeFlowFiles(login);
	return {
		team: path.join(repoPath, rel.team),
		legacy: path.join(repoPath, rel.legacy),
		personal: rel.personal ? path.join(repoPath, rel.personal) : undefined,
	};
}

/**
 * フローの定義のファイルの読み書きの口（パスはリポジトリからの相対、`/` 区切り）。手元のリポジトリは fs、SSH の接続先の
 * リポジトリは Para Code の中継（relay.ts の relayFlowIo）。read は無ければ undefined。
 */
export interface IFlowIo {
	read(relativePath: string): Promise<string | undefined>;
	write(relativePath: string, text: string): Promise<void>;
}

function localIo(repoPath: string): IFlowIo {
	return {
		read: async relativePath => {
			try {
				return await fs.readFile(path.join(repoPath, relativePath), 'utf8');
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
					return undefined;
				}
				throw err;
			}
		},
		write: (relativePath, text) => writeTextAtomic(path.join(repoPath, relativePath), text),
	};
}

/** 表示と問題の報告に使うパス（手元は絶対パス、接続先も接続先の絶対パス）。 */
function shown(repoPath: string, relativePath: string, io: IFlowIo | undefined): string {
	return io ? path.posix.join(repoPath, relativePath) : path.join(repoPath, relativePath);
}

async function readJson(io: IFlowIo, relativePath: string, label: string): Promise<unknown | undefined> {
	const text = await io.read(relativePath).catch(err => {
		throw new Error(`${label}: ${(err as Error).message}`);
	});
	if (text === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`${label}: ${(err as Error).message}`);
	}
}

export interface ILoadedFlows {
	readonly flows: ITaskBoardFlow[];
	readonly active?: string;
	readonly problems: ITaskBoardFlowProblem[];
	readonly sources: string[];
}

export async function loadFlows(repoPath: string | undefined, login: string | undefined, remoteIo?: IFlowIo): Promise<ILoadedFlows> {
	if (!repoPath) {
		return { flows: [TASK_BOARD_DEFAULT_FLOW], problems: [], sources: [] };
	}
	const io = remoteIo ?? localIo(repoPath);
	const rel = relativeFlowFiles(login);
	const label = (relativePath: string) => shown(repoPath, relativePath, remoteIo);
	const problems: ITaskBoardFlowProblem[] = [];
	const sources: string[] = [];
	let team: ITaskBoardFlow[] = [];
	let personal: ITaskBoardFlow[] = [];
	let active: string | undefined;
	const teamRaw = await readJson(io, rel.team, label(rel.team)).catch(err => { problems.push({ path: label(rel.team), message: String(err.message) }); return undefined; });
	const teamSource = teamRaw !== undefined ? rel.team : rel.legacy;
	const teamData = teamRaw ?? await readJson(io, rel.legacy, label(rel.legacy)).catch(err => { problems.push({ path: label(rel.legacy), message: String(err.message) }); return undefined; });
	if (teamData !== undefined) {
		const parsed = parseTaskBoardFlowFile(teamData, 'team', teamSource);
		team = parsed.flows;
		problems.push(...parsed.problems);
		if (team.length) {
			sources.push(label(teamSource));
		}
	}
	if (rel.personal) {
		const personalPath = rel.personal;
		const raw = await readJson(io, personalPath, label(personalPath)).catch(err => { problems.push({ path: label(personalPath), message: String(err.message) }); return undefined; });
		if (raw !== undefined) {
			const parsed = parseTaskBoardFlowFile(raw, 'personal', personalPath);
			personal = parsed.flows;
			problems.push(...parsed.problems);
			sources.push(label(personalPath));
			const rec = raw as { active?: unknown };
			if (typeof rec.active === 'string') {
				active = rec.active;
			}
		}
	}
	return { flows: mergeTaskBoardFlows([TASK_BOARD_DEFAULT_FLOW], team, personal), active, problems, sources };
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, text, 'utf8');
	await fs.rename(tmp, file);
}

/** フローを保存し、保存したファイルの（表示用の）絶対パスを返す。 */
export async function saveFlow(repoPath: string, login: string | undefined, flow: ITaskBoardFlow, scope: 'team' | 'personal', active?: string, remoteIo?: IFlowIo): Promise<string> {
	const io = remoteIo ?? localIo(repoPath);
	const rel = relativeFlowFiles(login);
	const target = scope === 'personal' ? rel.personal : rel.team;
	if (!target) {
		throw new Error('GitHub login is unknown; cannot decide the personal folder');
	}
	let existing = await readJson(io, target, shown(repoPath, target, remoteIo));
	if (existing === undefined && scope === 'team') {
		// 旧ファイルの設定（setup / teardown など）を新しい場所へ引き継ぐ
		existing = await readJson(io, rel.legacy, shown(repoPath, rel.legacy, remoteIo));
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
	await io.write(target, JSON.stringify(record, null, '\t') + '\n');
	return shown(repoPath, target, remoteIo);
}

/** 個人ファイルの「使うフロー」だけを書き換える。 */
export async function saveActiveFlow(repoPath: string, login: string | undefined, active: string, remoteIo?: IFlowIo): Promise<void> {
	const io = remoteIo ?? localIo(repoPath);
	const target = relativeFlowFiles(login).personal;
	if (!target) {
		return;
	}
	const existing = await readJson(io, target, shown(repoPath, target, remoteIo));
	const record = (existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}) as Record<string, unknown>;
	record.active = active;
	await io.write(target, JSON.stringify(record, null, '\t') + '\n');
}
