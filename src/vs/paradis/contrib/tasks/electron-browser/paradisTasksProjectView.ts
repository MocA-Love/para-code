/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面の「プロジェクト」（GitHub Projects v2）の項目を描く部分。GitHub のビューの種類に合わせ、
// テーブル（欄を列にした表）、ボード（単一選択の欄で分けた列）、ロードマップ（日付の欄で横に伸ばした帯）を描く。
// 取得はしない（画面の ParadisTasksEditor が読んだ結果を渡す）。

import * as dom from '../../../../base/browser/dom.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisTasksLabel, IParadisTasksUser } from '../common/paradisTasks.js';
import {
	IParadisTasksProjectField,
	IParadisTasksProjectItem,
	IParadisTasksProjectItemsResult,
	paradisTasksBoardColumns,
	paradisTasksBoardField,
	paradisTasksRoadmap,
	paradisTasksTableFields,
} from '../common/paradisTasksProjects.js';

const $ = dom.$;

export interface IParadisTasksProjectViewHost {
	/** 項目を開く（GitHub で開く。下書きは URL が無いので何もしない）。 */
	openItem(item: IParadisTasksProjectItem): void;
	/** 項目の「…」のメニュー。 */
	showItemMenu(item: IParadisTasksProjectItem, anchor: HTMLElement): void;
}

/** GitHub の選択肢の色の名前を、テーマの色に寄せる。 */
function optionColor(color: string | undefined): string {
	switch (color) {
		case 'BLUE': return 'var(--vscode-charts-blue)';
		case 'GREEN': return 'var(--vscode-charts-green)';
		case 'YELLOW': return 'var(--vscode-charts-yellow)';
		case 'ORANGE': return 'var(--vscode-charts-orange)';
		case 'RED': return 'var(--vscode-charts-red)';
		case 'PINK': return 'var(--vscode-charts-red)';
		case 'PURPLE': return 'var(--vscode-charts-purple)';
		default: return 'var(--vscode-descriptionForeground)';
	}
}

function itemReference(item: IParadisTasksProjectItem): string {
	if (item.kind === 'draft') {
		return localize('paradis.tasks.project.draft', "下書き");
	}
	return item.repository ? `${item.repository.split('/')[1]}#${item.number}` : `#${item.number}`;
}

function appendUsers(parent: HTMLElement, users: readonly IParadisTasksUser[]): void {
	if (users.length === 0) {
		dom.append(parent, $('span.paradis-tasks-faint')).textContent = '-';
	}
	for (const user of users) {
		const avatar = dom.append(parent, $('span.paradis-tasks-avatar'));
		avatar.title = user.login;
		if (user.avatarUrl?.startsWith('https://')) {
			const image = dom.append(avatar, $<HTMLImageElement>('img'));
			image.src = user.avatarUrl;
			image.alt = user.login;
		} else {
			avatar.textContent = user.login.slice(0, 2).toUpperCase();
		}
	}
}

function appendLabels(parent: HTMLElement, labels: readonly IParadisTasksLabel[]): void {
	for (const label of labels) {
		const chip = dom.append(parent, $('span.paradis-tasks-label'));
		chip.textContent = label.name;
		chip.style.borderColor = `#${label.color}8c`;
	}
}

/** 1 つの欄の値を描く。中身（Issue・PR）から取る欄（担当者・ラベル・リポジトリ）はここで埋める。 */
function appendFieldValue(parent: HTMLElement, item: IParadisTasksProjectItem, field: IParadisTasksProjectField): void {
	switch (field.dataType) {
		case 'ASSIGNEES':
			appendUsers(parent, item.assignees);
			return;
		case 'LABELS':
			appendLabels(parent, item.labels);
			return;
		case 'REPOSITORY':
			parent.textContent = item.repository ?? '';
			return;
	}
	const value = item.values[field.name];
	if (!value) {
		return;
	}
	if (field.dataType === 'SINGLE_SELECT') {
		const chip = dom.append(parent, $('span.paradis-tasks-option'));
		chip.textContent = value.text;
		chip.style.color = optionColor(value.color);
		return;
	}
	parent.textContent = value.text;
}

function appendTitle(parent: HTMLElement, item: IParadisTasksProjectItem): void {
	dom.append(parent, $('.paradis-tasks-item-title')).textContent = item.title;
	const context = dom.append(parent, $('.paradis-tasks-item-context'));
	dom.append(context, $('span.repo')).textContent = itemReference(item);
	if (item.kind === 'pr' && item.isDraft) {
		dom.append(context, $('span')).textContent = localize('paradis.tasks.project.prDraft', "ドラフト");
	}
	if (item.state === 'CLOSED' || item.state === 'MERGED') {
		dom.append(context, $('span')).textContent = item.state === 'MERGED'
			? localize('paradis.tasks.project.merged', "マージ済み")
			: localize('paradis.tasks.project.closed', "クローズ");
	}
}

function bindOpen(store: DisposableStore, element: HTMLElement, item: IParadisTasksProjectItem, host: IParadisTasksProjectViewHost): void {
	element.tabIndex = 0;
	store.add(dom.addDisposableListener(element, 'click', event => {
		if (!(event.target as HTMLElement).closest('button')) {
			host.openItem(item);
		}
	}));
	store.add(dom.addDisposableListener(element, 'keydown', event => {
		if (event.key === 'Enter') {
			host.openItem(item);
		}
	}));
}

function menuButton(store: DisposableStore, parent: HTMLElement, item: IParadisTasksProjectItem, host: IParadisTasksProjectViewHost): void {
	const button = dom.append(parent, $<HTMLButtonElement>('button.paradis-tasks-icon-button'));
	button.type = 'button';
	const label = localize('paradis.tasks.rowActions', "操作");
	button.title = label;
	button.setAttribute('aria-label', label);
	dom.append(button, $('span.codicon.codicon-ellipsis'));
	store.add(dom.addDisposableListener(button, 'click', () => host.showItemMenu(item, button)));
}

/** テーブル: タイトルの列と、ビューに出ている欄を列にした表。 */
export function paradisTasksRenderProjectTable(container: HTMLElement, result: IParadisTasksProjectItemsResult, store: DisposableStore, host: IParadisTasksProjectViewHost): void {
	const fields = paradisTasksTableFields(result.fields);
	const table = dom.append(container, $('table.paradis-tasks-table.paradis-tasks-project-table'));
	const head = dom.append(dom.append(table, $('thead')), $('tr'));
	dom.append(head, $('th.title')).textContent = localize('paradis.tasks.column.title', "タイトル/コンテキスト");
	for (const field of fields) {
		dom.append(head, $('th.field')).textContent = field.name;
	}
	dom.append(head, $('th.updated')).textContent = localize('paradis.tasks.column.updated', "更新済み");
	dom.append(head, $('th.actions'));
	const body = dom.append(table, $('tbody'));
	for (const item of result.items) {
		const row = dom.append(body, $('tr.paradis-tasks-item'));
		appendTitle(dom.append(row, $('td.title')), item);
		for (const field of fields) {
			appendFieldValue(dom.append(row, $('td.field')), item, field);
		}
		const updated = dom.append(row, $('td.updated'));
		const time = item.updatedAt ? Date.parse(item.updatedAt) : NaN;
		updated.textContent = isNaN(time) ? '' : fromNow(time, true);
		menuButton(store, dom.append(row, $('td.actions')), item, host);
		bindOpen(store, row, item, host);
	}
}

/** ボード: 単一選択の欄（ビューの設定、無ければ Status）の選択肢ごとの列にカードを並べる。 */
export function paradisTasksRenderProjectBoard(container: HTMLElement, result: IParadisTasksProjectItemsResult, store: DisposableStore, host: IParadisTasksProjectViewHost): void {
	const field = paradisTasksBoardField(result.fields, result.columnField);
	if (result.items.length < result.total) {
		// 列の件数は読めた分だけ（続きを読むと増える）
		dom.append(container, $('.paradis-tasks-note')).textContent = localize('paradis.tasks.board.partial', "全 {0} 件のうち {1} 件を読みました。列の件数は読めた分です。下の「続きを読む」で残りを読みます。", result.total, result.items.length);
	}
	const board = dom.append(container, $('.paradis-tasks-board'));
	// カードに出す欄（列にした欄・タイトル・担当者とラベル（カードに別に出す）は除く。多すぎると読めないので 3 つまで）
	const cardFields = paradisTasksTableFields(result.fields).filter(other => other.name !== field?.name && other.dataType !== 'ASSIGNEES' && other.dataType !== 'LABELS').slice(0, 3);
	for (const column of paradisTasksBoardColumns(result.items, field)) {
		const columnElement = dom.append(board, $('.paradis-tasks-board-column'));
		const header = dom.append(columnElement, $('.paradis-tasks-board-header'));
		const dot = dom.append(header, $('span.paradis-tasks-board-dot'));
		dot.style.backgroundColor = optionColor(column.color);
		dom.append(header, $('span.paradis-tasks-board-name')).textContent = column.name ?? localize('paradis.tasks.project.noValue', "{0} なし", field?.name ?? '');
		dom.append(header, $('span.paradis-tasks-board-count')).textContent = String(column.items.length);
		const cards = dom.append(columnElement, $('.paradis-tasks-board-cards'));
		for (const item of column.items) {
			const card = dom.append(cards, $('.paradis-tasks-card'));
			const top = dom.append(card, $('.paradis-tasks-card-top'));
			dom.append(top, $('span.paradis-tasks-card-ref')).textContent = itemReference(item);
			menuButton(store, top, item, host);
			dom.append(card, $('.paradis-tasks-card-title')).textContent = item.title;
			const meta = dom.append(card, $('.paradis-tasks-item-context'));
			appendLabels(meta, item.labels);
			for (const other of cardFields) {
				const value = dom.append(meta, $('span.paradis-tasks-card-field'));
				appendFieldValue(value, item, other);
				if (!value.textContent && !value.firstChild) {
					value.remove();
				}
			}
			if (item.assignees.length > 0) {
				appendUsers(dom.append(card, $('.paradis-tasks-card-assignees')), item.assignees);
			}
			bindOpen(store, card, item, host);
		}
	}
}

function shortDate(iso: string): string {
	return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

/**
 * ロードマップ: 左に項目の名前、右に月の目盛りと期間の帯。日付の欄が無いビューは false を返す（呼び出し側が表で出す）。
 * `todayIso` は今日の日付（`YYYY-MM-DD`）。
 */
export function paradisTasksRenderProjectRoadmap(container: HTMLElement, result: IParadisTasksProjectItemsResult, store: DisposableStore, host: IParadisTasksProjectViewHost, todayIso: string): boolean {
	const fieldNames = new Set(result.fields.map(field => field.name));
	const roadmap = paradisTasksRoadmap(result.items, [...result.fields, ...(result.dateFields ?? []).filter(field => !fieldNames.has(field.name))], todayIso);
	if (!roadmap) {
		return false;
	}
	const field = paradisTasksBoardField(result.fields, result.columnField);
	const percent = (value: number) => `${(Math.min(1, Math.max(0, value)) * 100).toFixed(3)}%`;
	const firstTick = roadmap.ticks[0]?.date;
	const lastTick = roadmap.ticks[roadmap.ticks.length - 1]?.date;
	const yearMonth = (iso: string) => localize('paradis.tasks.roadmap.yearMonth', "{0}年{1}月", iso.slice(0, 4), Number(iso.slice(5, 7)));
	const note = dom.append(container, $('.paradis-tasks-note'));
	dom.append(note, $('span')).textContent = roadmap.startField === roadmap.endField
		? localize('paradis.tasks.roadmap.oneField', "「{0}」の欄で並べています。", roadmap.startField)
		: localize('paradis.tasks.roadmap.twoFields', "「{0}」から「{1}」までの期間で並べています。", roadmap.startField, roadmap.endField);
	if (firstTick && lastTick) {
		dom.append(note, $('span')).textContent = localize('paradis.tasks.roadmap.range', "表示は {0}〜{1} です。", yearMonth(firstTick), yearMonth(lastTick));
	}
	const grid = dom.append(container, $('.paradis-tasks-roadmap'));
	const head = dom.append(grid, $('.paradis-tasks-roadmap-row.head'));
	dom.append(head, $('.paradis-tasks-roadmap-name'));
	const scale = dom.append(head, $('.paradis-tasks-roadmap-track'));
	roadmap.ticks.forEach((tick, index) => {
		// 端の短い月（幅の 6% 未満）は名前が隣と重なるので出さない（線は出す）
		const next = roadmap.ticks[index + 1]?.at ?? 1;
		if (next - tick.at < 0.06) {
			return;
		}
		const label = dom.append(scale, $('span.paradis-tasks-roadmap-tick'));
		label.style.left = percent(tick.at);
		label.style.maxWidth = percent(next - tick.at);
		// 年は見出しの文に出すので、目盛りは 1 月だけ年を付ける
		const withYear = tick.date.slice(5, 7) === '01';
		label.textContent = withYear
			? yearMonth(tick.date)
			: localize('paradis.tasks.roadmap.month', "{0}月", Number(tick.date.slice(5, 7)));
	});
	for (const row of roadmap.rows) {
		const line = dom.append(grid, $('.paradis-tasks-roadmap-row.paradis-tasks-item'));
		const name = dom.append(line, $('.paradis-tasks-roadmap-name'));
		dom.append(name, $('span.paradis-tasks-roadmap-ref')).textContent = itemReference(row.item);
		dom.append(name, $('span.paradis-tasks-roadmap-title')).textContent = row.item.title;
		const track = dom.append(line, $('.paradis-tasks-roadmap-track'));
		for (const tick of roadmap.ticks) {
			dom.append(track, $('span.paradis-tasks-roadmap-grid')).style.left = percent(tick.at);
		}
		if (roadmap.today !== undefined) {
			dom.append(track, $('span.paradis-tasks-roadmap-today')).style.left = percent(roadmap.today);
		}
		const bar = dom.append(track, $('span.paradis-tasks-roadmap-bar'));
		bar.style.left = percent(row.from);
		bar.style.width = `max(6px, ${percent(row.to - row.from)})`;
		const status = field ? row.item.values[field.name] : undefined;
		bar.style.backgroundColor = optionColor(status?.color);
		const period = row.startDate === row.endDate ? shortDate(row.startDate) : `${shortDate(row.startDate)} – ${shortDate(row.endDate)}`;
		bar.title = status ? `${period} · ${status.text}` : period;
		line.title = `${row.item.title}\n${bar.title}`;
		bindOpen(store, line, row.item, host);
	}
	if (roadmap.undated.length > 0) {
		dom.append(container, $('.paradis-tasks-roadmap-undated-title')).textContent = localize('paradis.tasks.roadmap.undated', "日付の無い項目（{0} 件）", roadmap.undated.length);
		const list = dom.append(container, $('.paradis-tasks-roadmap-undated'));
		for (const item of roadmap.undated) {
			const entry = dom.append(list, $('.paradis-tasks-roadmap-undated-item'));
			dom.append(entry, $('span.paradis-tasks-roadmap-ref')).textContent = itemReference(item);
			dom.append(entry, $('span')).textContent = item.title;
			bindOpen(store, entry, item, host);
		}
	}
	return true;
}
