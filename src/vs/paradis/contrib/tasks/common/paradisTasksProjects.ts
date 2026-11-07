/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面の「プロジェクト」（GitHub Projects v2）の型と、項目の並べ方。環境に依存しない純粋な部分。
// 取得は shared process（node/paradisTasksGithub.sharedProcess.ts）が手元の gh の GraphQL で行う。

import { IParadisTasksLabel, IParadisTasksRateLimit, IParadisTasksSearchService, IParadisTasksUser, ParadisTasksResponse } from './paradisTasks.js';

/** GitHub のビューの種類（`ProjectV2ViewLayout`）。 */
export type ParadisTasksViewLayout = 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT';

export interface IParadisTasksProjectView {
	readonly number: number;
	readonly name: string;
	readonly layout: ParadisTasksViewLayout;
	/** ビューに保存された絞り込み（`status:Todo assignee:@me` など）。 */
	readonly filter?: string;
}

export interface IParadisTasksProject {
	/** 持ち主（ユーザーか組織）の login。 */
	readonly owner: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly closed: boolean;
	readonly views: readonly IParadisTasksProjectView[];
}

export interface IParadisTasksProjectsRequest {
	/** `owner/name` の並び。各リポジトリにつながったプロジェクトと、持ち主の組織のプロジェクトを読む。 */
	readonly repositories: readonly string[];
	readonly force?: boolean;
}

export interface IParadisTasksProjectsResult {
	readonly projects: readonly IParadisTasksProject[];
	readonly fetchedAt: number;
	readonly rateLimit?: IParadisTasksRateLimit;
}

export interface IParadisTasksProjectField {
	readonly name: string;
	/** `ProjectV2FieldType`（TITLE / ASSIGNEES / SINGLE_SELECT / DATE / ITERATION / TEXT / NUMBER / LABELS など）。 */
	readonly dataType: string;
	/** 単一選択の欄の選択肢（並び順のまま）。 */
	readonly options?: readonly IParadisTasksFieldOption[];
}

export interface IParadisTasksFieldOption {
	readonly name: string;
	/** GitHub の色の名前（GRAY / BLUE / GREEN / YELLOW / ORANGE / RED / PINK / PURPLE）。 */
	readonly color?: string;
}

export interface IParadisTasksFieldValue {
	/** 画面に出す文字。 */
	readonly text: string;
	/** 単一選択の色の名前。 */
	readonly color?: string;
	/** 日付の欄（`YYYY-MM-DD`）。 */
	readonly date?: string;
	/** 繰り返しの欄の始まり（`YYYY-MM-DD`）と日数。 */
	readonly startDate?: string;
	readonly duration?: number;
}

export interface IParadisTasksProjectItem {
	readonly id: string;
	readonly kind: 'issue' | 'pr' | 'draft';
	readonly number?: number;
	readonly title: string;
	readonly url?: string;
	readonly repository?: string;
	readonly state?: string;
	readonly stateReason?: string;
	readonly isDraft?: boolean;
	readonly assignees: readonly IParadisTasksUser[];
	readonly labels: readonly IParadisTasksLabel[];
	readonly updatedAt?: string;
	/** 欄の名前 → 値。 */
	readonly values: { readonly [field: string]: IParadisTasksFieldValue };
}

export interface IParadisTasksProjectItemsRequest {
	readonly owner: string;
	readonly number: number;
	readonly view: number;
	/** ビューに保存された絞り込み（一覧で読んだもの。項目と一緒には読まないので、窓から渡す）。 */
	readonly viewFilter?: string;
	/** 人が書いた絞り込み。ビューの絞り込みの後ろに足す。 */
	readonly query?: string;
	readonly after?: string;
	readonly force?: boolean;
}

export interface IParadisTasksProjectItemsResult {
	readonly title: string;
	readonly url: string;
	readonly view: IParadisTasksProjectView;
	/** ビューに出ている欄（並び順のまま）。 */
	readonly fields: readonly IParadisTasksProjectField[];
	/** プロジェクトの日付・繰り返しの欄（ビューに出していないものも含む。ロードマップに使う）。 */
	readonly dateFields?: readonly IParadisTasksProjectField[];
	/** ボードの列にする欄の名前（ビューの設定。無ければ Status）。 */
	readonly columnField?: string;
	readonly items: readonly IParadisTasksProjectItem[];
	readonly total: number;
	readonly endCursor?: string;
	readonly hasNextPage: boolean;
	readonly fetchedAt: number;
	readonly rateLimit?: IParadisTasksRateLimit;
}

/** 「タスク」の画面の取得口（shared process のチャネル）。 */
export interface IParadisTasksGithubService extends IParadisTasksSearchService {
	listProjects(request: IParadisTasksProjectsRequest): Promise<ParadisTasksResponse<IParadisTasksProjectsResult>>;
	projectItems(request: IParadisTasksProjectItemsRequest): Promise<ParadisTasksResponse<IParadisTasksProjectItemsResult>>;
}

/** 1 回に読む項目の数。ボードは全部の列を一度に描くので、表より多めにする。 */
export const PARADIS_TASKS_PROJECT_PAGE_SIZE = 50;

/** ビューの絞り込みと人の絞り込みをつなぐ。両方とも空なら undefined（GitHub に絞り込みを渡さない）。 */
export function paradisTasksProjectItemsQuery(viewFilter: string | undefined, query: string | undefined): string | undefined {
	const joined = [viewFilter?.trim(), query?.trim()].filter(part => part).join(' ');
	return joined.length > 0 ? joined : undefined;
}

export interface IParadisTasksBoardColumn {
	/** 選択肢の名前。値が無い項目の列は undefined。 */
	readonly name: string | undefined;
	readonly color?: string;
	readonly items: readonly IParadisTasksProjectItem[];
}

/**
 * ボードの列に分ける。列の並びは欄の選択肢の順で、値が無い項目は先頭の「未設定」の列に入れる（GitHub と同じ）。
 * 選択肢に無い値（読んだ後に消えた選択肢など）は末尾に列を足す。
 */
export function paradisTasksBoardColumns(items: readonly IParadisTasksProjectItem[], field: IParadisTasksProjectField | undefined): IParadisTasksBoardColumn[] {
	const buckets = new Map<string | undefined, IParadisTasksProjectItem[]>();
	const options = field?.options ?? [];
	buckets.set(undefined, []);
	for (const option of options) {
		buckets.set(option.name, []);
	}
	for (const item of items) {
		const value = field ? item.values[field.name]?.text : undefined;
		const key = value && value.length > 0 ? value : undefined;
		if (!buckets.has(key)) {
			buckets.set(key, []);
		}
		buckets.get(key)!.push(item);
	}
	const colorOf = new Map(options.map(option => [option.name, option.color]));
	const columns: IParadisTasksBoardColumn[] = [];
	for (const [name, bucket] of buckets) {
		// 「未設定」の列は項目があるときだけ出す
		if (name === undefined && bucket.length === 0) {
			continue;
		}
		columns.push({ name, color: name === undefined ? undefined : colorOf.get(name), items: bucket });
	}
	return columns;
}

/** ボードの列にする欄。ビューの設定が無ければ「Status」という名前の単一選択の欄、それも無ければ最初の単一選択の欄。 */
export function paradisTasksBoardField(fields: readonly IParadisTasksProjectField[], configured: string | undefined): IParadisTasksProjectField | undefined {
	const singleSelects = fields.filter(field => field.dataType === 'SINGLE_SELECT');
	return (configured ? fields.find(field => field.name === configured) : undefined)
		?? singleSelects.find(field => field.name.toLowerCase() === 'status')
		?? singleSelects[0];
}

/** 表の列にする欄。タイトル（行の頭に出す）と、表で出しようのない欄（子 Issue の進み具合など）は外す。 */
export function paradisTasksTableFields(fields: readonly IParadisTasksProjectField[]): IParadisTasksProjectField[] {
	const hidden = new Set(['TITLE', 'TRACKS', 'TRACKED_BY', 'SUB_ISSUES_PROGRESS', 'PARENT_ISSUE']);
	return fields.filter(field => !hidden.has(field.dataType));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IParadisTasksRoadmapRow {
	readonly item: IParadisTasksProjectItem;
	/** 始まりと終わり（その日を含む）の、表示の幅の中の位置（0〜1）。 */
	readonly from: number;
	readonly to: number;
	/** 画面に出す期間（`11/3 – 11/20` の元になる日付。`YYYY-MM-DD`）。 */
	readonly startDate: string;
	readonly endDate: string;
}

export interface IParadisTasksRoadmapTick {
	/** その月の 1 日（`YYYY-MM-DD`）。 */
	readonly date: string;
	readonly at: number;
}

export interface IParadisTasksRoadmap {
	/** 期間に使った欄の名前（開始・終了。1 つの日付の欄なら同じ名前、繰り返しの欄ならその名前）。 */
	readonly startField: string;
	readonly endField: string;
	readonly rows: readonly IParadisTasksRoadmapRow[];
	/** 日付の無い項目。 */
	readonly undated: readonly IParadisTasksProjectItem[];
	/** 月の始まりの目盛り。 */
	readonly ticks: readonly IParadisTasksRoadmapTick[];
	/** 今日の位置（表示の幅の外なら undefined）。 */
	readonly today?: number;
}

const START_NAMES = /^(start|begin|開始|着手|開始日|start date)/i;
const END_NAMES = /^(end|target|due|finish|deadline|終了|期限|締切|完了予定|target date|end date|due date)/i;

/**
 * ロードマップに使う欄を選ぶ。GitHub はロードマップの日付の欄をビューの設定に持つが、API では読めないので、
 * 名前で開始・終了の日付の欄を探し、無ければ繰り返しの欄、それも無ければ最初の日付の欄（1 日の点）を使う。
 */
export function paradisTasksRoadmapFields(fields: readonly IParadisTasksProjectField[]): { readonly start: string; readonly end: string; readonly iteration: boolean } | undefined {
	const dates = fields.filter(field => field.dataType === 'DATE');
	const start = dates.find(field => START_NAMES.test(field.name));
	const end = dates.find(field => field !== start && END_NAMES.test(field.name));
	if (start && end) {
		return { start: start.name, end: end.name, iteration: false };
	}
	const iteration = fields.find(field => field.dataType === 'ITERATION');
	if (iteration) {
		return { start: iteration.name, end: iteration.name, iteration: true };
	}
	const single = start ?? end ?? dates[0];
	return single ? { start: single.name, end: single.name, iteration: false } : undefined;
}

function parseDay(value: string | undefined): number | undefined {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return undefined;
	}
	const time = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
	return isNaN(time) ? undefined : time;
}

function formatDay(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

/**
 * 項目をロードマップの行に並べる。表示の幅は、日付のある項目の最初の月の 1 日から最後の月の末日まで（今日も含める）。
 * 片方の日付しか無い項目は 1 日の点にする。終わりが始まりより前なら入れ替える。並びは始まりの順（同じなら元の順）。
 * `todayIso` は今日の日付（`YYYY-MM-DD`。テストで決めるために渡す）。
 */
export function paradisTasksRoadmap(items: readonly IParadisTasksProjectItem[], fields: readonly IParadisTasksProjectField[], todayIso: string): IParadisTasksRoadmap | undefined {
	const chosen = paradisTasksRoadmapFields(fields);
	if (!chosen) {
		return undefined;
	}
	const spans: { item: IParadisTasksProjectItem; start: number; end: number; index: number }[] = [];
	const undated: IParadisTasksProjectItem[] = [];
	items.forEach((item, index) => {
		let start: number | undefined;
		let end: number | undefined;
		if (chosen.iteration) {
			const value = item.values[chosen.start];
			start = parseDay(value?.startDate);
			end = start !== undefined ? start + Math.max(1, value?.duration ?? 1) * DAY_MS - DAY_MS : undefined;
		} else {
			start = parseDay(item.values[chosen.start]?.date);
			end = parseDay(item.values[chosen.end]?.date);
		}
		start ??= end;
		end ??= start;
		if (start === undefined || end === undefined) {
			undated.push(item);
			return;
		}
		spans.push({ item, start: Math.min(start, end), end: Math.max(start, end), index });
	});
	const today = parseDay(todayIso);
	const anchors = spans.flatMap(span => [span.start, span.end]);
	if (today !== undefined) {
		anchors.push(today);
	}
	if (anchors.length === 0) {
		return { startField: chosen.start, endField: chosen.end, rows: [], undated, ticks: [] };
	}
	const first = new Date(Math.min(...anchors));
	const last = new Date(Math.max(...anchors));
	const rangeStart = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
	const rangeEnd = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1);
	const width = rangeEnd - rangeStart;
	const at = (time: number) => (time - rangeStart) / width;
	const ticks: IParadisTasksRoadmapTick[] = [];
	for (let month = new Date(rangeStart); month.getTime() < rangeEnd; month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
		ticks.push({ date: formatDay(month.getTime()), at: at(month.getTime()) });
	}
	spans.sort((a, b) => a.start - b.start || a.index - b.index);
	return {
		startField: chosen.start,
		endField: chosen.end,
		rows: spans.map(span => ({ item: span.item, from: at(span.start), to: at(span.end + DAY_MS), startDate: formatDay(span.start), endDate: formatDay(span.end) })),
		undated,
		ticks,
		today: today !== undefined ? at(today) : undefined,
	};
}

/**
 * ロードマップの目盛りのうち、名前を出す月の番号（{@link IParadisTasksRoadmap.ticks} の添字）。月が多いと名前が重なるので、
 * 12 か月までは毎月、36 か月までは四半期（1・4・7・10 月）、それより長いと 1 月だけにする。1 月はいつも出す。
 * 両端の月は、幅が足りない（全体の 6% 未満）ときだけ外す（隣の月の名前と重なるため）。
 */
export function paradisTasksRoadmapLabelledTicks(ticks: readonly IParadisTasksRoadmapTick[]): number[] {
	const monthOf = (tick: IParadisTasksRoadmapTick) => Number(tick.date.slice(5, 7));
	const every = ticks.length <= 12 ? 1 : ticks.length <= 36 ? 3 : 12;
	const result: number[] = [];
	ticks.forEach((tick, index) => {
		const month = monthOf(tick);
		if ((month - 1) % every !== 0) {
			return;
		}
		const width = (ticks[index + 1]?.at ?? 1) - tick.at;
		const edge = index === 0 || index === ticks.length - 1;
		if (edge && width < 0.06) {
			return;
		}
		result.push(index);
	});
	return result;
}
