// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useAppStore } from '../appState.js';
import type { AgentChatState, WorkspaceState } from '../store.js';

/**
 * 開発ビルド専用: PC とペアリングしていないシミュレータで画面を確かめるための見本のデータ。
 *
 * ストアに「接続中の MacBook Pro」と「オフラインの Mac mini」、3つのスペースと7つのターミナル、
 * 許可待ち・質問・実行中などの会話を入れる。PC とはつながっていないので、送信や要求は届かない
 * （画面の並びと動きを見るためのもの）。呼ぶのはデバッガから（`globalThis.__paraDev.demo()`。
 * `src/devProbe.tsx`）。`__DEV__` でなければ何もしない。データはすべて架空。
 */

const MBP = 'demo-mbp';
const MINI = 'demo-mini';

const terminal = (id: number, key: string, title: string, ws: string, agentStatus?: string, agent = true): WorkspaceState['terminals'][number] => ({
	terminalKey: key,
	id,
	windowId: 1,
	rendererGeneration: 1,
	title,
	ws,
	agent,
	...(agent ? { agentToken: `token-${key}` } : {}),
	...(agentStatus !== undefined ? { agentStatus } : {}),
	cols: 120,
	rows: 40,
});

function demoWorkspace(): WorkspaceState {
	return {
		protocolVersion: 3,
		desktopEpoch: 'demo-epoch',
		revision: 1,
		complete: true,
		renderers: [{ windowId: 1, rendererGeneration: 1, ready: true }],
		activeWs: 'ws-para',
		workspaces: [
			{ id: 'ws-para', sourceId: 'src-para', windowId: 1, name: 'para-code', color: '#a78bfa', branch: 'feat/auth', note: { open: 3, done: 2 } },
			{ id: 'ws-web', sourceId: 'src-web', windowId: 1, name: 'web-app', color: '#22c55e', branch: 'fix/types' },
			{ id: 'ws-docs', sourceId: 'src-docs', windowId: 1, name: 'docs', color: '#eab308', branch: 'main' },
		],
		terminals: [
			terminal(1, 'demo-auth', '認証フローの整理', 'ws-para', 'permission'),
			terminal(2, 'demo-relay', 'リレー再接続のテスト', 'ws-para', 'question'),
			terminal(3, 'demo-diff', 'Diff ビューの配色', 'ws-para', 'working'),
			terminal(4, 'demo-zsh', 'zsh', 'ws-para', undefined, false),
			terminal(5, 'demo-types', '型エラーの修正', 'ws-web', 'working'),
			terminal(6, 'demo-build', 'ビルド設定の整理', 'ws-web'),
			terminal(7, 'demo-readme', 'README の更新', 'ws-docs', 'done'),
			terminal(8, 'demo-notes', '調査メモ', 'ws-docs'),
		],
		battery: { level: 82, charging: true },
		pcName: 'MacBook Pro',
	};
}

function chat(agent: string, messages: AgentChatState['messages'], extra: Partial<AgentChatState> = {}): AgentChatState {
	return { agent, epoch: 'demo', rev: messages.length, messages, truncated: false, info: { model: 'Opus', effort: 'high' } as AgentChatState['info'], ...extra };
}

function demoChats(): Map<string, AgentChatState> {
	const now = Date.now();
	return new Map<string, AgentChatState>([
		['demo-auth', chat('claude', [
			{ rev: 1, role: 'user', kind: 'text', text: '認証フローを整理して、テストも追加して', ts: now - 180_000 },
			{ rev: 2, role: 'assistant', kind: 'text', text: '了解しました。まず現在の実装を確認します。', ts: now - 170_000 },
			{ rev: 3, role: 'assistant', kind: 'tool_use', tool: 'Read', text: 'src/auth/session.ts', ts: now - 160_000 },
			{ rev: 4, role: 'tool', kind: 'tool_result', text: '214 lines', toolUseId: 't1', ts: now - 159_000 },
			{ rev: 5, role: 'assistant', kind: 'tool_use', tool: 'Edit', text: 'src/auth/session.ts +42 −18', ts: now - 120_000 },
			{ rev: 6, role: 'assistant', kind: 'text', text: '依存関係を入れ直してテストを流します。', ts: now - 60_000 },
		], {
			interaction: {
				kind: 'approval',
				id: 'demo-approval',
				title: 'Bash',
				detail: 'rm -rf node_modules && pnpm install && pnpm test --filter relay',
				choices: [
					{ id: 'allow', label: '許可', tone: 'approve' },
					{ id: 'deny', label: '拒否', tone: 'deny' },
				],
			},
		})],
		['demo-diff', chat('claude', [
			{ rev: 1, role: 'user', kind: 'text', text: 'Diff ビューの配色をダークテーマに合わせて', ts: now - 720_000 },
			{ rev: 2, role: 'assistant', kind: 'text', text: '追加と削除の色をテーマのトークンに寄せます。', ts: now - 700_000 },
			{ rev: 3, role: 'assistant', kind: 'tool_use', tool: 'Edit', text: 'src/components/diffView.tsx +42 −18', ts: now - 650_000 },
		])],
		['demo-types', chat('codex', [
			{ rev: 1, role: 'user', kind: 'text', text: '型エラーを直して', ts: now - 120_000 },
			{ rev: 2, role: 'assistant', kind: 'tool_use', tool: 'Bash', text: 'pnpm tsc --noEmit', ts: now - 100_000 },
		])],
		['demo-build', chat('claude', [
			{ rev: 1, role: 'user', kind: 'text', text: 'ビルド設定を整理して', ts: now - 3_600_000 },
			{ rev: 2, role: 'assistant', kind: 'text', text: '整理しました。ほかに直すところはありますか？', ts: now - 3_500_000 },
		])],
	]);
}

/** 見本のデータを入れる（開発ビルドだけ）。 */
export function installDemoData(): void {
	if (!__DEV__) {
		return;
	}
	const now = Date.now();
	useAppStore.setState({
		ready: true,
		paired: true,
		initializing: false,
		pcs: [
			{ id: MBP, name: 'MacBook Pro', hue: 210, connection: 'online', pcOnline: true, workspaces: 3, terminals: 8, waiting: 2, lastOnlineAt: now, battery: { level: 82, charging: true } },
			{ id: MINI, name: 'Mac mini', hue: 30, connection: 'offline', pcOnline: false, workspaces: 0, terminals: 0, waiting: 0, lastOnlineAt: now - 2 * 3_600_000, battery: undefined },
		],
		activePcId: MBP,
		connection: 'online',
		pcOnline: true,
		sessionProtocolReady: true,
		workspace: demoWorkspace(),
		agentChats: demoChats(),
		selectedWs: 'ws-para',
		pinnedKeys: new Set(['demo-notes']),
	});
}
