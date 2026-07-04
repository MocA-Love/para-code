/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の ccusage 実行チャネルを呼び、ダッシュボード表示用の
// 正規化済みデータ(IParadisCcusageDashboardData)へ変換するクライアント。
// ccusage の生 JSON 構造はレポート毎に形が違うため、UI からは直接参照させない。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisCcusageBlock,
	IParadisCcusageDailyRow,
	IParadisCcusageExecOptions,
	IParadisCcusageSessionRow,
	PARADIS_CCUSAGE_CHANNEL,
	ParadisCcusageAgent,
	ParadisCcusageProjects,
	paradisCcusageAgentForModel
} from '../common/paradisCcusage.js';

export const PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH = 'paradis.ccusage.executablePath';

/** 常に取得する期間(日)。UI の期間フィルターの最大値と一致させる。 */
export const FETCH_WINDOW_DAYS = 90;

/** 1日×1モデルのスライス(積み上げバー・モデル別集計の元データ)。 */
export interface IParadisCcusageModelSlice {
	readonly model: string;
	readonly agent: ParadisCcusageAgent;
	readonly cost: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheCreationTokens: number;
	readonly cacheReadTokens: number;
}

export interface IParadisCcusageDayData {
	/** YYYY-MM-DD。 */
	readonly date: string;
	readonly models: IParadisCcusageModelSlice[];
}

export interface IParadisCcusageBlockData {
	readonly startTime: number;
	readonly endTime: number;
	readonly costUSD: number;
	readonly remainingMinutes: number | undefined;
	readonly projectedCost: number | undefined;
	readonly projectedTokens: number | undefined;
	readonly costPerHour: number | undefined;
	readonly tokensPerMinute: number | undefined;
}

export interface IParadisCcusageSessionData {
	/** 表示用に整形済みのプロジェクト名。 */
	readonly project: string;
	/** ccusage が返す生のプロジェクトパス表記(ツールチップ用)。 */
	readonly rawProject: string;
	readonly lastActivity: number | undefined;
	readonly models: string[];
	readonly totalTokens: number;
	readonly totalCost: number;
}

export interface IParadisCcusageProjectData {
	readonly name: string;
	readonly rawName: string;
	/** 日別コスト(YYYY-MM-DD → USD)。期間フィルターはクライアント側で行う。 */
	readonly dailyCosts: { readonly date: string; readonly cost: number }[];
}

export interface IParadisCcusageDashboardData {
	readonly days: IParadisCcusageDayData[];
	readonly block: IParadisCcusageBlockData | undefined;
	readonly sessions: IParadisCcusageSessionData[];
	readonly projects: IParadisCcusageProjectData[];
	/** 部分的に取得へ失敗したレポート名(UI で注記表示する)。 */
	readonly failedReports: string[];
	readonly fetchedAt: number;
}

/** ローカル時刻で YYYYMMDD を返す。 */
export function paradisCcusageDateArg(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}${m}${d}`;
}

/**
 * ccusage の "-Users-magu-github-para-code" 形式のプロジェクト表記から表示名を作る。
 * パス区切りが '-' に潰されていて復元不能なため、ホームディレクトリ相当の前置きを
 * ヒューリスティックに取り除くだけに留める(元表記はツールチップで参照可能にする)。
 */
export function paradisCcusageProjectDisplayName(rawName: string): string {
	let name = rawName.replace(/^-(?:Users|home)-[^-]+-/, '');
	name = name.replace(/^(?:github|projects|repos|src|dev|work)-/, '');
	return name.length > 0 ? name : rawName;
}

export class ParadisCcusageClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	private get channel() {
		return this.sharedProcessService.getChannel(PARADIS_CCUSAGE_CHANNEL);
	}

	private execOptions(sinceDays: number | undefined, bypassCache?: boolean): IParadisCcusageExecOptions {
		const executablePath = this.configurationService.getValue<string>(PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH);
		const options: { executablePath?: string; since?: string; bypassCache?: boolean } = {};
		if (typeof executablePath === 'string' && executablePath.trim().length > 0) {
			options.executablePath = executablePath.trim();
		}
		if (sinceDays !== undefined) {
			const since = new Date();
			since.setDate(since.getDate() - (sinceDays - 1));
			options.since = paradisCcusageDateArg(since);
		}
		if (bypassCache) {
			options.bypassCache = true;
		}
		return options;
	}

	/**
	 * 今日1日分の合計コスト(USD)。ステータスバー表示用。
	 * ダッシュボードと同じ「90日分の daily」を呼ぶことで shared process のキャッシュを共有する
	 * (ccusage の走査コストは since に依らずほぼ一定なので、絞っても速くならない)。
	 */
	async fetchTodayCost(): Promise<number | undefined> {
		const rows = await this.channel.call<IParadisCcusageDailyRow[]>('fetchDaily', [this.execOptions(FETCH_WINDOW_DAYS)]);
		if (!Array.isArray(rows) || rows.length === 0) {
			return undefined;
		}
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		const todayRow = rows.find(row => row.period === today);
		return todayRow ? (todayRow.totalCost ?? 0) : 0;
	}

	/**
	 * ダッシュボード一式を取得する。常に最大期間(90日)分を取得し、期間の絞り込みは
	 * 呼び出し側(エディタ)が日付でスライスする — 期間切り替えのたびに CLI を再実行しないため。
	 * 一部レポートの失敗は failedReports として返し、全体は成立させる。
	 */
	async fetchDashboard(bypassCache = false): Promise<IParadisCcusageDashboardData> {
		const options = this.execOptions(FETCH_WINDOW_DAYS, bypassCache);
		const [daily, block, sessions, projects] = await Promise.allSettled([
			this.channel.call<IParadisCcusageDailyRow[]>('fetchDaily', [options]),
			this.channel.call<IParadisCcusageBlock | undefined>('fetchActiveBlock', [this.execOptions(undefined, bypassCache)]),
			this.channel.call<IParadisCcusageSessionRow[]>('fetchRecentSessions', [options]),
			this.channel.call<ParadisCcusageProjects>('fetchProjects', [options]),
		]);

		const failedReports: string[] = [];
		if (daily.status === 'rejected') {
			failedReports.push('daily');
		}
		if (block.status === 'rejected') {
			failedReports.push('blocks');
		}
		if (sessions.status === 'rejected') {
			failedReports.push('session');
		}
		if (projects.status === 'rejected') {
			failedReports.push('projects');
		}
		// daily はダッシュボードの土台なので、失敗したらエラーとして扱う
		if (daily.status === 'rejected') {
			throw daily.reason instanceof Error ? daily.reason : new Error(String(daily.reason));
		}

		return {
			days: normalizeDaily(daily.value),
			block: block.status === 'fulfilled' ? normalizeBlock(block.value) : undefined,
			sessions: sessions.status === 'fulfilled' ? normalizeSessions(sessions.value) : [],
			projects: projects.status === 'fulfilled' ? normalizeProjects(projects.value) : [],
			failedReports,
			fetchedAt: Date.now(),
		};
	}
}

function normalizeDaily(rows: IParadisCcusageDailyRow[]): IParadisCcusageDayData[] {
	const days: IParadisCcusageDayData[] = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row || typeof row.period !== 'string') {
			continue;
		}
		const models: IParadisCcusageModelSlice[] = [];
		for (const breakdown of row.modelBreakdowns ?? []) {
			if (!breakdown || typeof breakdown.modelName !== 'string') {
				continue;
			}
			models.push({
				model: breakdown.modelName,
				agent: paradisCcusageAgentForModel(breakdown.modelName),
				cost: breakdown.cost ?? 0,
				inputTokens: breakdown.inputTokens ?? 0,
				outputTokens: breakdown.outputTokens ?? 0,
				cacheCreationTokens: breakdown.cacheCreationTokens ?? 0,
				cacheReadTokens: breakdown.cacheReadTokens ?? 0,
			});
		}
		days.push({ date: row.period, models });
	}
	days.sort((a, b) => a.date.localeCompare(b.date));
	return days;
}

function normalizeBlock(block: IParadisCcusageBlock | undefined): IParadisCcusageBlockData | undefined {
	if (!block) {
		return undefined;
	}
	const startTime = Date.parse(block.startTime);
	const endTime = Date.parse(block.endTime);
	if (isNaN(startTime) || isNaN(endTime)) {
		return undefined;
	}
	return {
		startTime,
		endTime,
		costUSD: block.costUSD ?? 0,
		remainingMinutes: block.projection?.remainingMinutes,
		projectedCost: block.projection?.totalCost,
		projectedTokens: block.projection?.totalTokens,
		costPerHour: block.burnRate?.costPerHour,
		tokensPerMinute: block.burnRate?.tokensPerMinute,
	};
}

function normalizeSessions(rows: IParadisCcusageSessionRow[]): IParadisCcusageSessionData[] {
	const sessions: IParadisCcusageSessionData[] = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row) {
			continue;
		}
		const rawProject = row.projectPath ?? row.sessionId ?? '';
		const lastActivity = row.lastActivity ? Date.parse(row.lastActivity) : NaN;
		sessions.push({
			project: paradisCcusageProjectDisplayName(rawProject),
			rawProject,
			lastActivity: isNaN(lastActivity) ? undefined : lastActivity,
			models: row.modelsUsed ?? [],
			totalTokens: row.totalTokens ?? 0,
			totalCost: row.totalCost ?? (row.modelBreakdowns ?? []).reduce((sum, b) => sum + (b.cost ?? 0), 0),
		});
	}
	sessions.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
	return sessions;
}

function normalizeProjects(projects: ParadisCcusageProjects): IParadisCcusageProjectData[] {
	const result: IParadisCcusageProjectData[] = [];
	for (const [rawName, rows] of Object.entries(projects ?? {})) {
		const dailyCosts = (Array.isArray(rows) ? rows : [])
			.filter(row => typeof row?.date === 'string')
			.map(row => ({ date: row.date!, cost: row.totalCost ?? 0 }));
		result.push({ name: paradisCcusageProjectDisplayName(rawName), rawName, dailyCosts });
	}
	return result;
}
