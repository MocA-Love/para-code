// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext, type ReactNode } from 'react';
import type { ITaskBoardFlow, ITaskBoardRpc, ITaskBoardSnapshot, ITaskBoardTask, TaskBoardRpcMethod } from '@engine/paradisTaskBoard.js';
import type { Tone } from './format.js';

export type ViewId = 'board' | 'inbox' | 'list' | 'flow';
export type TabId = 'issue' | 'pr' | 'progress' | 'plan' | 'mock' | 'artifacts' | 'terminal';

export interface IToast {
	readonly title: string;
	readonly body?: string;
	readonly tone: Tone;
	readonly taskId?: string;
}

export interface IApp {
	readonly snapshot: ITaskBoardSnapshot;
	readonly view: ViewId;
	readonly selectedId: string | undefined;
	readonly tab: TabId;
	readonly query: string;
	readonly onlyMine: boolean;
	setView(view: ViewId): void;
	openTask(taskId: string, tab?: TabId): void;
	closeTask(): void;
	setTab(tab: TabId): void;
	toast(toast: IToast): void;
	showDialog(node: ReactNode): void;
	closeDialog(): void;
	/** サーバーに送る。失敗したらトーストで知らせ、undefined を返す。 */
	call<M extends TaskBoardRpcMethod>(method: M, params: ITaskBoardRpc[M]['params'], success?: IToast): Promise<ITaskBoardRpc[M]['result'] | undefined>;
	flowOf(task: ITaskBoardTask): ITaskBoardFlow;
	matches(task: ITaskBoardTask): boolean;
}

export const AppContext = createContext<IApp | undefined>(undefined);

export function useApp(): IApp {
	const app = useContext(AppContext);
	if (!app) {
		throw new Error('AppContext missing');
	}
	return app;
}
