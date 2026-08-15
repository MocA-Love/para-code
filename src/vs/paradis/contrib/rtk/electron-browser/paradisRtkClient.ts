/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE コメント)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// renderer から shared process の rtk 実行チャネルを呼び、ダッシュボード表示用の
// 正規化済みデータ(IParadisRtkDashboardData)へ変換するクライアント。
// rtk の生の値は snake_case のままなので、UI からは直接参照させない。
// rtk は手元のマシンの記録しか持たないため、SSH 接続中でも常に shared process へ聞く。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisRtkCommandRow,
	IParadisRtkDailyRow,
	IParadisRtkExecOptions,
	IParadisRtkHistoryEntry,
	IParadisRtkSummary,
	PARADIS_RTK_CHANNEL
} from '../common/paradisRtk.js';

export const PARADIS_RTK_SETTING_EXECUTABLE_PATH = 'paradis.rtk.executablePath';

/** コマンド別内訳で表示する上限。 */
export const MAX_COMMAND_ROWS = 10;

/** 1日分の節約量(グラフ・KPIの元データ)。 */
export interface IParadisRtkDayData {
	/** YYYY-MM-DD。 */
	readonly date: string;
	readonly commands: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly savedTokens: number;
	readonly totalTimeMs: number;
}

export interface IParadisRtkTotals {
	readonly commands: number;
	readonly inputTokens: number;
	readonly savedTokens: number;
	readonly totalTimeMs: number;
}

export interface IParadisRtkDashboardData {
	readonly days: IParadisRtkDayData[];
	readonly totals: IParadisRtkTotals;
	readonly commands: IParadisRtkCommandRow[];
	readonly history: IParadisRtkHistoryEntry[];
	/** 部分的に取得へ失敗したレポート名(UI で注記表示する)。 */
	readonly failedReports: string[];
	readonly fetchedAt: number;
}

/** ローカル時刻で YYYY-MM-DD を返す(rtk の daily.date と同じ基準)。 */
export function paradisRtkLocalDateString(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 節約率(%)。rtk の savings_pct と同じく「入力に対して何%削れたか」で出す。 */
export function paradisRtkSavingsPercent(savedTokens: number, inputTokens: number): number {
	return inputTokens > 0 ? (savedTokens / inputTokens) * 100 : 0;
}

export class ParadisRtkClient {

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) { }

	private get channel() {
		return this.sharedProcessService.getChannel(PARADIS_RTK_CHANNEL);
	}

	private execOptions(bypassCache?: boolean): IParadisRtkExecOptions {
		const executablePath = this.configurationService.getValue<string>(PARADIS_RTK_SETTING_EXECUTABLE_PATH);
		const options: { executablePath?: string; bypassCache?: boolean } = {};
		if (typeof executablePath === 'string' && executablePath.trim().length > 0) {
			options.executablePath = executablePath.trim();
		}
		if (bypassCache) {
			options.bypassCache = true;
		}
		return options;
	}

	/**
	 * 今日1日分の節約トークン数。ステータスバー表示用。
	 * ダッシュボードと同じ呼び出しを使うことで shared process のキャッシュを共有する。
	 * 今日の記録がまだ無い場合は undefined(0 と区別する)。
	 */
	async fetchTodaySaved(): Promise<number | undefined> {
		const rows = await this.channel.call<IParadisRtkDailyRow[]>('fetchDaily', [this.execOptions()]);
		if (!Array.isArray(rows) || rows.length === 0) {
			return undefined;
		}
		const today = paradisRtkLocalDateString(new Date());
		const todayRow = rows.find(row => row.date === today);
		return todayRow ? (todayRow.saved_tokens ?? 0) : undefined;
	}

	/**
	 * ダッシュボード一式を取得する。期間の絞り込みは呼び出し側(エディタ)が日付でスライスする
	 * — rtk は常に全期間を返すため、期間切り替えのたびに CLI を再実行する必要が無い。
	 * 一部レポートの失敗は failedReports として返し、全体は成立させる。
	 */
	async fetchDashboard(bypassCache = false): Promise<IParadisRtkDashboardData> {
		const options = this.execOptions(bypassCache);
		const [summary, daily, commands, history] = await Promise.allSettled([
			this.channel.call<IParadisRtkSummary>('fetchSummary', [options]),
			this.channel.call<IParadisRtkDailyRow[]>('fetchDaily', [options]),
			this.channel.call<IParadisRtkCommandRow[]>('fetchByCommand', [options]),
			this.channel.call<IParadisRtkHistoryEntry[]>('fetchRecentHistory', [options]),
		]);

		const failedReports: string[] = [];
		if (summary.status === 'rejected') {
			failedReports.push('summary');
		}
		if (commands.status === 'rejected') {
			failedReports.push('by command');
		}
		if (history.status === 'rejected') {
			failedReports.push('recent commands');
		}
		// daily はダッシュボードの土台なので、失敗したらエラーとして扱う
		if (daily.status === 'rejected') {
			throw daily.reason instanceof Error ? daily.reason : new Error(String(daily.reason));
		}

		return {
			days: normalizeDaily(daily.value),
			totals: normalizeTotals(summary.status === 'fulfilled' ? summary.value : undefined),
			commands: commands.status === 'fulfilled' ? normalizeCommands(commands.value) : [],
			history: history.status === 'fulfilled' ? normalizeHistory(history.value) : [],
			failedReports,
			fetchedAt: Date.now(),
		};
	}
}

function normalizeDaily(rows: IParadisRtkDailyRow[]): IParadisRtkDayData[] {
	const days: IParadisRtkDayData[] = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row || typeof row.date !== 'string') {
			continue;
		}
		days.push({
			date: row.date,
			commands: row.commands ?? 0,
			inputTokens: row.input_tokens ?? 0,
			outputTokens: row.output_tokens ?? 0,
			savedTokens: row.saved_tokens ?? 0,
			totalTimeMs: row.total_time_ms ?? 0,
		});
	}
	days.sort((a, b) => a.date.localeCompare(b.date));
	return days;
}

function normalizeTotals(summary: IParadisRtkSummary | undefined): IParadisRtkTotals {
	return {
		commands: summary?.total_commands ?? 0,
		inputTokens: summary?.total_input ?? 0,
		savedTokens: summary?.total_saved ?? 0,
		totalTimeMs: summary?.total_time_ms ?? 0,
	};
}

function normalizeCommands(rows: IParadisRtkCommandRow[]): IParadisRtkCommandRow[] {
	return (Array.isArray(rows) ? rows : [])
		.filter(row => row && typeof row.command === 'string')
		.sort((a, b) => b.savedTokens - a.savedTokens);
}

function normalizeHistory(entries: IParadisRtkHistoryEntry[]): IParadisRtkHistoryEntry[] {
	return (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.command === 'string');
}
