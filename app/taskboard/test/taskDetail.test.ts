// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { ITaskBoardActivity, ITaskBoardSnapshot, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { listTask, parseClientMessage, taskDetail, taskDetailSignature } from '../server/taskDetail.js';
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

	test('目印は活動か出力が増えたとき・上限で入れ替わったときに変わる', () => {
		const base = taskDetailSignature(task('t1'));
		expect([
			taskDetailSignature(task('t1')) === base,
			taskDetailSignature(task('t1', { activities: [activity('Read'), activity('Edit')] })) === base,
			taskDetailSignature(task('t1', { log: ['line 1', 'line 2'] })) === base,
			taskDetailSignature(task('t1', { log: ['line 2'] })) === base,
			taskDetailSignature(task('t1', { activities: [activity('Edit')] })) === base,
		]).toEqual([true, false, false, false, false]);
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
