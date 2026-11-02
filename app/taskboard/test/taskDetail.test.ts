// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { ITaskBoardActivity, ITaskBoardSnapshot, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { listTask, parseClientMessage, taskDetail, TaskDetailFeed } from '../server/taskDetail.js';
import { withTaskDetail } from '../src/taskDetail.js';

const activity = (label: string): ITaskBoardActivity => ({ kind: 'tool', label, at: 1 } as ITaskBoardActivity);
const task = (id: string, over: Partial<ITaskBoardTask> = {}): ITaskBoardTask => ({
	id, title: id, history: [{ stepId: 'plan' }], activities: [activity('Read')], log: ['line 1'],
	artifacts: [{ id: 'a1', kind: 'plan', title: 'plan', content: '# plan' }],
	...over,
} as unknown as ITaskBoardTask);

describe('一覧のスナップショットと開いているタスクの詳しい分', () => {
	test('一覧には活動・出力・成果物の本文を載せず、詳しい分は開いているタスクだけに戻す', () => {
		const listed = listTask(task('t1'));
		const snapshot = { version: 1, tasks: [listed, listTask(task('t2'))] } as unknown as ITaskBoardSnapshot;
		const merged = withTaskDetail(snapshot, taskDetail(task('t1')));
		expect({
			listed: [listed.activities, listed.log, listed.artifacts.map(a => [a.content, a.hasContent]), listed.history.length],
			merged: merged.tasks.map(t => [t.id, t.activities.length, t.log]),
			otherTask: withTaskDetail(snapshot, taskDetail(task('gone'))) === snapshot,
			noDetail: withTaskDetail(snapshot, undefined) === snapshot,
		}).toEqual({
			listed: [[], [], [[undefined, true]], 1],
			merged: [['t1', 1, ['line 1']], ['t2', 0, []]],
			otherTask: true,
			noDetail: true,
		});
	});

	test('開いた画面にだけ、開いた直後と足されたときに送り、閉じたら送らない（つなぎ直しは新しい接続として知らせ直す）', () => {
		const tasks = new Map([['t1', task('t1')], ['t2', task('t2')]]);
		const revisions = new Map([['t1', 1], ['t2', 1]]);
		const sent: string[] = [];
		const feed = new TaskDetailFeed<string>(
			{ getTask: id => tasks.get(id), getTaskDetailRevision: id => revisions.get(id) ?? 0 },
			(socket, text) => sent.push(`${socket}:${(JSON.parse(text) as { detail: { taskId: string; log: string[] } }).detail.taskId}:${(JSON.parse(text) as { detail: { log: string[] } }).detail.log.length}`),
		);
		const step = (label: string, action: () => void) => {
			sent.length = 0;
			action();
			return [label, [...sent]];
		};
		expect([
			step('open', () => feed.receive('a', '{"type":"focus","taskId":"t1"}')),
			step('unchanged', () => feed.changed()),
			step('other task grew', () => { revisions.set('t2', 2); feed.changed(); }),
			step('same line again after the limit', () => { revisions.set('t1', 2); feed.changed(); }),
			step('second screen', () => feed.receive('b', '{"type":"focus","taskId":"t2"}')),
			step('a closes the task', () => { feed.receive('a', '{"type":"focus"}'); revisions.set('t1', 3); feed.changed(); }),
			step('b disconnects', () => { feed.closed('b'); revisions.set('t2', 3); feed.changed(); }),
			step('b reconnects', () => feed.receive('b2', '{"type":"focus","taskId":"t2"}')),
			step('removed task', () => { tasks.delete('t2'); revisions.set('t2', 4); feed.changed(); }),
		]).toEqual([
			['open', ['a:t1:1']],
			['unchanged', []],
			['other task grew', []],
			['same line again after the limit', ['a:t1:1']],
			['second screen', ['b:t2:1']],
			['a closes the task', []],
			['b disconnects', []],
			['b reconnects', ['b2:t2:1']],
			['removed task', []],
		]);
	});

	test('画面からのメッセージは focus だけを受け、知らない形は無視する', () => {
		expect([
			parseClientMessage('{"type":"focus","taskId":"gh:o/r#7"}'),
			parseClientMessage('{"type":"focus"}'),
			parseClientMessage('{"type":"focus","taskId":""}'),
			parseClientMessage(`{"type":"focus","taskId":"${'x'.repeat(201)}"}`),
			parseClientMessage('{"type":"focus","taskId":7}'),
			parseClientMessage('{"type":"rpc"}'),
			parseClientMessage('not json'),
		]).toEqual([{ type: 'focus', taskId: 'gh:o/r#7' }, { type: 'focus' }, undefined, undefined, undefined, undefined, undefined]);
	});
});
