// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { botFileKey, botKey, useBotPages } from '../features/bots/botStore.js';
import type { MobileBot } from '../features/bots/bots.js';
import { useHumanAsks } from '../features/humanAsks/humanAskStore.js';
import type { HumanAsk } from '../features/humanAsks/humanAsks.js';
import { useAppStore, usePcAgentSources } from '../appState.js';
import { countRunningAgents } from '../attentionCount.js';
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
		protocolVersion: 4,
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
			{ ...terminal(9, 'demo-bot-release', 'リリース係', 'ws-para'), botId: 'bot-release' },
		],
		// Bot の節（bots.page.v1）と要対応の台帳（human-ask.v1）を見るための広告だけ
		capabilities: ['bots.page.v1', 'human-ask.v1'],
		bots: DEMO_BOTS,
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
		], {
			// コンポーザーの Monitor のピルとシートを見るための見本（実行中 2 件と、終わったばかりの 1 件）。
			monitors: [
				{ id: 'bdemo01', description: 'iOS ビルドの進行と失敗シグナル', command: 'tail -f /tmp/paracode-ios-build.log | grep -E --line-buffered "error:|\\*\\* BUILD|Bundling"', startedAt: now - 332_000, timeoutMs: 1_800_000, status: 'running', output: [{ at: now - 200_000, text: '› Planning build' }, { at: now - 90_000, text: '› Compiling ParaCode (arm64)' }], eventCount: 2 },
				{ id: 'bdemo02', description: 'git extension integration test run for PR62', command: 'tail -f /tmp/pr62-integration-test.log | grep -E --line-buffered "passing|failing|Error"', startedAt: now - 724_000, persistent: true, status: 'running', output: [], eventCount: 0 },
				{ id: 'bdemo03', description: 'paracode-80 publish job outcome', startedAt: now - 168_000, timeoutMs: 900_000, status: 'completed', endedAt: now - 30_000, output: [{ at: now - 31_000, text: 'RELEASE RUN completed success' }], eventCount: 1 },
			],
		})],
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
	const workspace = demoWorkspace();
	// 全 PC 横断の一覧（`/agents`）が読む PC ごとの元も、いま見ている PC のぶんだけ入れる。
	usePcAgentSources.setState({ byPc: { [MBP]: { terminals: workspace.terminals, spaces: workspace.workspaces, activeWs: workspace.activeWs, archived: [] } } });
	useAppStore.setState({
		ready: true,
		paired: true,
		initializing: false,
		pcs: [
			{ id: MBP, name: 'MacBook Pro', hue: 210, connection: 'online', pcOnline: true, pairingRejected: false, workspaces: 3, terminals: 8, waiting: 2 + DEMO_HUMAN_ASKS.length, running: countRunningAgents(workspace.terminals, []), lastOnlineAt: now, battery: { level: 82, charging: true }, humanAskSupported: true, humanAsks: { count: DEMO_HUMAN_ASKS.length, signature: 'demo' } },
			{ id: MINI, name: 'Mac mini', hue: 30, connection: 'offline', pcOnline: false, pairingRejected: false, workspaces: 0, terminals: 0, waiting: 0, running: 0, lastOnlineAt: now - 2 * 3_600_000, battery: undefined },
		],
		activePcId: MBP,
		connection: 'online',
		pcOnline: true,
		sessionProtocolReady: true,
		workspace,
		agentChats: demoChats(),
		selectedWs: 'ws-para',
		pinnedKeys: new Set(['demo-notes']),
	});
	// 要対応の「質問と承認」の段（human-ask.v1）。印が同じなので取り直しには行かない
	useHumanAsks.setState({ byPc: { [MBP]: { signature: 'demo', asks: DEMO_HUMAN_ASKS.map(ask => ({ ...ask, askedAt: now - ask.askedAt })) } } });
	// Bot のページ（項目・提案・項目のページ・ファイル）。PC が無いので取り直しは失敗し、この値のまま残る
	const release = botKey(MBP, 'bot-release');
	useBotPages.setState({
		items: {
			[release]: [
				{ uid: 'item42', number: 42, title: 'Safari でログインが切れる', status: 'needs_you', waits: true, lastActivityAt: now - 2 * 60_000 },
				{ uid: 'item43', number: 43, title: 'paracode-184 の変更履歴をまとめる', status: 'working', waits: false, lastActivityAt: now - 4 * 60_000 },
				{ uid: 'item44', number: 44, title: 'CSV の書き出しを直す', status: 'waiting', waits: false, lastActivityAt: now - 8 * 60_000 },
				{ uid: 'item45', number: 45, title: 'ベータの告知文を下書きする', status: 'planned', waits: false, lastActivityAt: now - 30 * 60_000 },
				{ uid: 'item40', number: 40, title: 'paracode-183 のタグを打つ', status: 'done', waits: false, lastActivityAt: now - 26 * 3_600_000, closedAt: now - 26 * 3_600_000 },
			],
		},
		suggestions: {
			[release]: [
				{ id: 'sug1', title: 'PR #1108 の指摘 2 件に返事が無い', request: '#1108 のレビューの指摘を読んで、直すか理由を返すか決めて', state: 'open', createdAt: now - 3_600_000 },
			],
		},
		pages: {
			[botKey(MBP, 'item42')]: {
				uid: 'item42', number: 42, botId: 'bot-release', title: 'Safari でログインが切れる', status: 'needs_you', waits: true, lastActivityAt: now - 2 * 60_000,
				description: 'Safari だけログイン後にセッションが切れます。原因は Cookie の SameSite です。',
				doneMeans: 'Safari・Chrome・Firefox でログインが 1 日続く',
				askEventId: 7, links: [{ kind: 'pr', ref: 'MocA-Love/example#1120' }], locked: false,
				events: [
					{ id: 1, kind: 'made', actor: 'owner', at: now - 3 * 3_600_000 },
					{ id: 4, kind: 'commented', actor: 'bot', at: now - 20 * 60_000, text: '原因は Cookie の SameSite=None が Safari で落ちることでした。' },
					{ id: 7, kind: 'status', actor: 'bot', at: now - 2 * 60_000, from: 'working', to: 'needs_you' },
				],
			},
		},
		files: {
			[botFileKey(MBP, 'bot-release', 'SOUL.md')]: '# リリース係\n\nリリースの手前の確認と、変更履歴をまとめる係です。\nタグを打つ前に必ず確かめます。\n',
			[botFileKey(MBP, 'bot-release', 'MEMORY.md')]: '# Memory\n\n- paracode-183 は 2026-11-26 に出した\n- ベータは macOS だけ\n',
		},
	});
}

/** Bot の見本（リリース係のペインは terminal 9）。 */
const DEMO_BOTS: MobileBot[] = [
	{ id: 'bot-release', name: 'リリース係', agent: 'claude', modelId: 'opus', permissionId: 'default', faceColor: 'blue', faceShape: 'drop', paused: false, pinned: true, needsYou: 1, openItems: 4, openSuggestions: 1, activity: 'idle', lastActivityAt: 0 },
	{ id: 'bot-review', name: 'レビュー係', agent: 'codex', faceColor: 'teal', faceShape: 'squircle', paused: false, pinned: false, needsYou: 1, openItems: 2, openSuggestions: 0, activity: 'working', lastActivityAt: 0 },
	{ id: 'bot-patrol', name: '見回り係', agent: 'claude', faceColor: 'amber', faceShape: 'hex', paused: false, pinned: false, needsYou: 0, openItems: 0, openSuggestions: 0, activity: 'patrolling', lastActivityAt: 0 },
	{ id: 'bot-translate', name: '翻訳係', agent: 'claude', faceColor: 'violet', faceShape: 'blob', paused: true, pinned: false, needsYou: 0, openItems: 0, openSuggestions: 0, activity: 'stopped', lastActivityAt: 0 },
];

/** 要対応の台帳の 1 件の見本（`askedAt` は今からの差）。 */
const DEMO_HUMAN_ASKS: readonly HumanAsk[] = [
	{
		key: 'bot:item42.ev7', source: 'bot', kind: 'question', from: { title: 'リリース係', detail: '項目 #42' },
		preface: 'Safari だけログイン後にセッションが切れます。原因は Cookie の SameSite です。',
		questions: [{ id: 'q0', text: '全員を一度ログアウトさせますか、今のセッションを残しますか?', options: [{ id: '0', label: '一度ログアウトさせる' }, { id: '1', label: '今のセッションを残す', detail: '影響は小さい', recommended: true }], allowText: true }],
		actions: [], canSkip: true, askedAt: 2 * 60_000, busy: false, failed: false,
	},
	{
		key: 'board:demo:415:approval', source: 'board', kind: 'approval', from: { title: '#415 計画の承認', detail: '計測キーの名前を除外規則に当たらないものに変える' },
		preface: '計画「計画」を見て、承認か差し戻しを選んでください',
		questions: [],
		actions: [{ id: 'approve', label: '承認して次へ' }, { id: 'sendBack', label: '差し戻す', allowText: true, confirm: { title: '差し戻しますか', body: '担当が計画を書き直します', ok: '差し戻す' } }, { id: 'complete', label: '完了扱いにする', confirm: { title: '完了扱いにしますか', body: 'エージェントの報告を待たずに次の工程へ進めます', ok: '完了扱いにする' } }],
		canSkip: false, askedAt: 8 * 60_000, busy: false, failed: false,
	},
	{
		key: 'pane:ask:demo', source: 'pane', kind: 'question', from: { title: 'api', detail: 'main ／ Codex' },
		questions: [
			{ id: 'q0', text: 'どの環境から直しますか?', options: [{ id: '0', label: 'staging' }, { id: '1', label: 'production' }], allowText: false },
			{ id: 'q1', text: '直す範囲は?', options: [{ id: '0', label: 'ログイン' }, { id: '1', label: '決済' }, { id: '2', label: '通知' }], allowText: true, multiSelect: true },
		],
		actions: [], canSkip: false, askedAt: 15 * 60_000, busy: false, failed: true,
	},
];
