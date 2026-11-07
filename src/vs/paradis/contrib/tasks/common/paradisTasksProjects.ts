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
