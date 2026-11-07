/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「タスク」の画面の「プロジェクト」（GitHub Projects v2）の項目を描く部分。GitHub のビューの種類に合わせ、
// テーブル（欄を列にした表）とボード（単一選択の欄で分けた列）を描く。ロードマップは表で出す（次の版で描く）。
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
	const board = dom.append(container, $('.paradis-tasks-board'));
	// カードに出す欄（列にした欄とタイトルは除く。多すぎると読めないので 3 つまで）
	const cardFields = paradisTasksTableFields(result.fields).filter(other => other.name !== field?.name && other.dataType !== 'ASSIGNEES').slice(0, 3);
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
