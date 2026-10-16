// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type {
	ITaskBoardCheck,
	ITaskBoardComment,
	ITaskBoardIssueDetail,
	ITaskBoardManualSession,
	ITaskBoardPrRef,
	ITaskBoardPullDetail,
	ITaskBoardQuestion,
	ITaskBoardSlot,
	ITaskBoardStep,
	ITaskBoardTask,
} from '@engine/paradisTaskBoard.js';
import type { ITaskBoardAgentPort, ITaskBoardRunPort, ITaskBoardWorkspacePort, TaskBoardEngine } from '@engine/paradisTaskBoardEngine.js';

/*
 * エージェント・コマンド・作業場所のシミュレーション（フェーズ 1〜2 の開発用）。
 * 本物の Claude Code / Codex はフェーズ 3 で para-browser MCP 経由につなぐ。
 * 画面には「シミュレーション」と出し、本物と取り違えないようにする。
 */

const TOOLS: readonly (readonly [string, string])[] = [
	['Read', 'src/vs/paradis/contrib/{area}/browser/paradis{Area}.ts'],
	['Grep', 'onDidChange{Area}'],
	['Read', 'src/vs/paradis/contrib/{area}/common/paradis{Area}.ts'],
	['Edit', 'src/vs/paradis/contrib/{area}/browser/paradis{Area}.ts'],
	['Write', 'src/vs/paradis/contrib/{area}/test/common/paradis{Area}.test.ts'],
	['Bash', 'scripts/test.sh --grep {area}'],
	['Glob', 'src/vs/paradis/contrib/{area}/**/*.ts'],
	['Edit', 'src/vs/paradis/paradis.common.contribution.ts'],
];

const AREAS = ['terminalSearch', 'portList', 'notifications', 'settingsDialog', 'diffFold', 'zoomIndicator', 'history'];

function pick<T>(list: readonly T[], seed: number): T {
	return list[Math.abs(seed) % list.length];
}

function hash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = (h * 31 + text.charCodeAt(i)) | 0;
	}
	return h;
}

export function mockHtml(title: string, variant: 'a' | 'b'): string {
	const rows = [['zsh', '12', 'curl --max-<mark>timeout</mark> 5 http://localhost:8080'], ['zsh', '48', 'export REQUEST_<mark>TIMEOUT</mark>=30'], ['node', '7', 'Error: connect ETIMEDOUT (<mark>timeout</mark>)']];
	const body = variant === 'a'
		? `<nav><b>zsh <i>2</i></b><span>node <i>1</i></span><span>claude <i>0</i></span></nav><p class="h">「timeout」の検索結果　zsh のタブ</p>${rows.filter(r => r[0] === 'zsh').map(r => `<div class="r"><em>${r[1]}</em>${r[2]}</div>`).join('')}`
		: `<p class="h">「timeout」の検索結果　すべてのタブ　${rows.length} 件</p>${rows.map(r => `<div class="r"><u>${r[0]}</u><em>${r[1]}</em>${r[2]}</div>`).join('')}`;
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;background:#0d1117;color:#e6edf3;font:13px -apple-system,sans-serif}
nav{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid #222932}nav>*{padding:4px 10px;border-radius:6px;color:#8b949e}nav b{background:#1f2630;color:#e6edf3;font-weight:500}nav i{font-style:normal;color:#09aed9;font-weight:700}
.h{padding:10px 14px;margin:0;color:#8b949e;border-bottom:1px solid #222932}.r{padding:6px 14px;font:12px ui-monospace,Menlo,monospace}
em{display:inline-block;width:34px;color:#6e7681;font-style:normal}u{display:inline-block;width:56px;color:#09aed9;text-decoration:none}mark{background:#5a4a00;color:#ffe08a}
</style></head><body>${body}</body></html>`;
}

export function screenshotSvg(index: number, title: string): string {
	const x = 60 + index * 90;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="#0d1117"/><rect width="1280" height="44" fill="#161b22"/>
<circle cx="24" cy="22" r="6" fill="#ff6b6b"/><circle cx="44" cy="22" r="6" fill="#e3b341"/><circle cx="64" cy="22" r="6" fill="#3fb950"/>
<rect x="0" y="44" width="220" height="676" fill="#12161c"/>
${Array.from({ length: 9 }, (_, i) => `<rect x="24" y="${76 + i * 34}" width="${120 + (i * 37) % 60}" height="12" rx="4" fill="#222932"/>`).join('')}
${Array.from({ length: 14 }, (_, i) => `<rect x="260" y="${80 + i * 30}" width="${300 + (i * 97) % 520}" height="10" rx="4" fill="#1f2630"/>`).join('')}
<rect x="${x + 600}" y="${120 + index * 40}" width="150" height="40" rx="20" fill="#09aed9" opacity=".9"/>
<text x="${x + 675}" y="${146 + index * 40}" font-family="-apple-system,sans-serif" font-size="16" fill="#022a35" text-anchor="middle">${100 + index * 25}%</text>
<text x="1256" y="704" font-family="-apple-system,sans-serif" font-size="13" fill="#6e7681" text-anchor="end">${title.replace(/[<&>]/g, '')} — ${index + 1}</text></svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export interface ISimulationOptions {
	readonly engine: () => TaskBoardEngine;
	readonly onManualChange: () => void;
	readonly repo?: { owner: string; repo: string };
	/** 見本の「フロー外のエージェント」を出すか（--demo のときだけ）。 */
	readonly demoManual?: boolean;
}

export class Simulation implements ITaskBoardAgentPort, ITaskBoardRunPort, ITaskBoardWorkspacePort {
	private readonly timers = new Map<string, NodeJS.Timeout[]>();
	private readonly asked = new Set<string>();
	private readonly waitScheduled = new Set<string>();
	private speed = 1;
	/** 見本のタスクへのコメント（GitHub には書き込まない）。 */
	private readonly comments = new Map<string, ITaskBoardComment[]>();
	private prSeq = 900;
	readonly manual: ITaskBoardManualSession[];
	private manualTimer: NodeJS.Timeout | undefined;

	constructor(private readonly options: ISimulationOptions) {
		const now = Date.now();
		this.manual = !options.demoManual ? [] : [
			{ id: 'm-main', name: 'para-code', branch: 'main', agent: 'claude', status: 'working', text: '#377 を参照して調べています', since: now - 7 * 60000 },
			{ id: 'm-hotfix', name: 'para-code-worktrees/hotfix', branch: 'para/hotfix-tab', agent: 'codex', status: 'permission', text: '許可: Bash: npm run typecheck-client', since: now - 2 * 60000 },
		];
		this.manualTimer = setInterval(() => this.tickManual(), 9000);
	}

	setSpeed(speed: number): void {
		this.speed = Math.max(0.25, Math.min(20, speed));
	}

	getSpeed(): number {
		return this.speed;
	}

	dispose(): void {
		for (const list of this.timers.values()) {
			list.forEach(clearTimeout);
		}
		this.timers.clear();
		clearInterval(this.manualTimer);
	}

	private get engine(): TaskBoardEngine {
		return this.options.engine();
	}

	private later(taskId: string, ms: number, fn: () => void): void {
		const timer = setTimeout(() => {
			const list = this.timers.get(taskId);
			if (list) {
				list.splice(list.indexOf(timer), 1);
			}
			fn();
		}, Math.max(30, ms / this.speed));
		const list = this.timers.get(taskId) ?? [];
		list.push(timer);
		this.timers.set(taskId, list);
	}

	private clear(taskId: string): void {
		this.timers.get(taskId)?.forEach(clearTimeout);
		this.timers.delete(taskId);
	}

	private area(task: ITaskBoardTask): string {
		return pick(AREAS, hash(task.id));
	}

	private toolLine(task: ITaskBoardTask, n: number): readonly [string, string] {
		const [tool, arg] = pick(TOOLS, hash(task.id) + n * 7);
		const area = this.area(task);
		return [tool, arg.replace('{area}', area).replace('{Area}', area[0].toUpperCase() + area.slice(1))];
	}

	/* ---------------- エージェント ---------------- */

	startStep(task: ITaskBoardTask, step: ITaskBoardStep, prompt: string): void {
		this.clear(task.id);
		const engine = this.engine;
		const cli = task.agent === 'codex' ? 'codex' : 'claude';
		engine.reportModel(task.id, cli === 'codex' ? 'gpt-6.1-sol' : 'opus');
		engine.reportOutput(task.id, [`~/projects/${engine.getSlots().find(s => s.id === task.place)?.name ?? 'para-code'} $ ${cli}`, `› ${prompt}`]);
		engine.reportMessage(task.id, task.attempt, `${step.name}を始めます`);
		this.runTools(task.id, step, task.attempt, 3 + (Math.abs(hash(task.id + step.id)) % 4), 0);
	}

	private runTools(taskId: string, step: ITaskBoardStep, attempt: number, remaining: number, n: number): void {
		this.later(taskId, 1100 + (Math.abs(hash(taskId + n)) % 1400), () => {
			const task = this.engine.getTask(taskId);
			if (!task || task.attempt !== attempt || (task.status !== 'working' && task.status !== 'stalled')) {
				return;
			}
			const [tool, arg] = this.toolLine(task, n);
			this.engine.reportToolUse(taskId, attempt, tool, arg, Math.min(92, (task.contextPct ?? 8) + 3 + (n % 4)));
			this.engine.reportOutput(taskId, [`  ⎿ ${tool} ${arg}`]);
			if (remaining > 1) {
				this.runTools(taskId, step, attempt, remaining - 1, n + 1);
			} else {
				this.finishStep(taskId, step, attempt);
			}
		});
	}

	private isFirstAgentStep(task: ITaskBoardTask, step: ITaskBoardStep): boolean {
		const flow = this.engine.flowOf(task);
		return flow.steps.find(s => s.kind === 'agent')?.id === step.id;
	}

	private finishStep(taskId: string, step: ITaskBoardStep, attempt: number): void {
		const engine = this.engine;
		const task = engine.getTask(taskId);
		if (!task || task.attempt !== attempt) {
			return;
		}
		const key = `${taskId}:${step.id}`;
		const answered = task.activities.some(a => a.kind === 'answer' && a.at >= task.stepSince);
		if (this.isFirstAgentStep(task, step) && !this.asked.has(key) && !answered) {
			this.asked.add(key);
			const a = engine.addArtifact(taskId, attempt, { kind: 'mock', title: '案 A タブごと', path: `mocks/${this.slugNum(task)}-a.html`, content: mockHtml('案 A', 'a') });
			const b = engine.addArtifact(taskId, attempt, { kind: 'mock', title: '案 B まとめる', path: `mocks/${this.slugNum(task)}-b.html`, content: mockHtml('案 B', 'b') });
			engine.reportOutput(taskId, ['● モックを 2 案作りました', '? 結果をタブごとに分けますか、1 つにまとめますか']);
			engine.reportQuestion(taskId, attempt, {
				text: '結果をタブごとに分けますか、1 つにまとめますか',
				options: [
					{ label: 'タブごとに分ける', detail: '既存の検索ビューと揃う。モック案 A', artifactId: a },
					{ label: '1 つにまとめ、行の頭にタブ名を出す', detail: '全部を一度に見られる。モック案 B', artifactId: b },
				],
				allowText: true,
			});
			return;
		}
		// 報告を忘れて止まる様子も時々見せる（デモ用）
		if (!this.asked.has(`${key}:idle`) && Math.abs(hash(key)) % 11 === 3) {
			this.asked.add(`${key}:idle`);
			engine.reportOutput(taskId, ['● 変更を終えました。']);
			engine.reportIdle(taskId, attempt);
			return;
		}
		const artifacts = [];
		if (this.isFirstAgentStep(task, step)) {
			artifacts.push({ kind: 'plan' as const, title: '計画', path: `docs/plan-${this.slugNum(task)}.md`, content: this.planMarkdown(task) });
		}
		if (/スクショ|screenshot|shot/i.test(step.name + step.id)) {
			for (let i = 0; i < 3; i++) {
				artifacts.push({ kind: 'screenshot' as const, title: `screenshot-${i + 1}.png`, path: `.para-code/shots/${this.slugNum(task)}-${i + 1}.png`, content: screenshotSvg(i, task.title) });
			}
		}
		if (step.id === 'review' || /レビュー/.test(step.name)) {
			artifacts.push({ kind: 'report' as const, title: 'レビュー結果', content: '## 指摘\n\n- 1 件を修正しました（空白の扱い）\n- ほかに指摘はありません' });
		}
		engine.reportOutput(taskId, ['● 完了しました', `  ⎿ board_complete_step: ${step.id}`]);
		engine.reportStepComplete(taskId, attempt, { summary: `${step.name}が終わりました`, artifacts });
	}

	private slugNum(task: ITaskBoardTask): string {
		return task.issue ? String(task.issue.number) : task.id.slice(-6);
	}

	private planMarkdown(task: ITaskBoardTask): string {
		const area = this.area(task);
		return [
			'## 目的',
			'',
			task.body?.split('\n').find(l => l.trim()) ?? task.title,
			'',
			'## 手順',
			'',
			`- [ ] \`paradis${area[0].toUpperCase()}${area.slice(1)}\` に新しい処理を足す`,
			'- [ ] 既存ファイルの変更は import 1 行に抑える',
			'- [ ] 単体テストを足す',
			'- [ ] 更新履歴の未リリースに 1 行足す',
			'',
			'## 変更するファイル',
			'',
			'| ファイル | 種類 | 内容 |',
			'| --- | --- | --- |',
			`| \`src/vs/paradis/contrib/${area}/browser/paradis${area}Feature.ts\` | 新規 | 本体 |`,
			'| `src/vs/paradis/paradis.common.contribution.ts` | 変更 | import 1 行 |',
			`| \`src/vs/paradis/contrib/${area}/test/common/paradis${area}Feature.test.ts\` | 新規 | テスト |`,
			'',
			'## 確かめ方',
			'',
			'関係する単体テストを回し、変更した画面のスクショを PR に添付する。',
		].join('\n');
	}

	answer(task: ITaskBoardTask, question: ITaskBoardQuestion, answer: string): void {
		const engine = this.engine;
		engine.reportOutput(task.id, [question.kind === 'permission' ? `◆ 許可の確認に回答: ${answer}` : `› ${answer}`]);
		const step = engine.flowOf(task).steps.find(s => s.id === task.step);
		if (!step) {
			return;
		}
		if (question.kind === 'permission') {
			this.runTools(task.id, step, task.attempt, 2, 20);
			return;
		}
		engine.reportMessage(task.id, task.attempt, '回答を受けて計画をまとめています');
		this.runTools(task.id, step, task.attempt, 2, 10);
	}

	sendInput(task: ITaskBoardTask, text: string): void {
		const step = this.engine.flowOf(task).steps.find(s => s.id === task.step);
		if (!step || step.kind !== 'agent') {
			return;
		}
		if (task.status === 'working' && !this.timers.get(task.id)?.length) {
			this.runTools(task.id, step, task.attempt, 1, 30);
		}
	}

	sendKey(task: ITaskBoardTask, key: string): void {
		if (key === 'Ctrl+C') {
			this.clear(task.id);
			this.engine.reportOutput(task.id, ['^C', '● 中断しました']);
			this.engine.reportIdle(task.id, task.attempt);
		}
	}

	stop(task: ITaskBoardTask): void {
		this.clear(task.id);
		this.engine.reportOutput(task.id, ['● 止めました']);
	}

	/* ---------------- コマンド ---------------- */

	cancel(task: ITaskBoardTask): void {
		this.clear(task.id);
		this.engine.reportOutput(task.id, ['^C　コマンドを止めました']);
	}

	run(task: ITaskBoardTask, step: ITaskBoardStep): void {
		const engine = this.engine;
		const attempt = task.attempt;
		if (step.run === 'draft-pr') {
			engine.reportOutput(task.id, [`$ gh pr create --draft --head ${task.branch ?? 'para/task'}`]);
			this.later(task.id, 1600, () => {
				const number = ++this.prSeq;
				const owner = task.issue?.owner ?? this.options.repo?.owner ?? 'example';
				const repo = task.issue?.repo ?? this.options.repo?.repo ?? 'para-code';
				const pr: ITaskBoardPrRef = { owner, repo, number, url: '', title: task.title, state: 'draft', checks: 'pending', checksPassed: 1, checksTotal: 4, review: 'none', simulated: true };
				engine.reportRunResult(task.id, attempt, { ok: true, detail: `#${number}`, pr, log: [`  ⎿ シミュレーションの PR #${number} を作りました（GitHub には作っていません）`] });
			});
			return;
		}
		const command = step.command || 'true';
		engine.reportOutput(task.id, [`$ ${command}`]);
		const fail = Math.abs(hash(task.id + step.id + (task.history.length))) % 5 === 1;
		const names = ['load', 'dedupe', 'restore', 'render'];
		names.forEach((name, i) => {
			this.later(task.id, 700 * (i + 1), () => {
				const failed = fail && (i === 1 || i === 2);
				engine.reportOutput(task.id, [`  ${failed ? '✗' : '✓'} ${this.area(task)}.${name}${failed ? (i === 1 ? '（期待 3 行、実際 4 行）' : '（Timeout of 20000ms exceeded）') : ` (${300 + i * 211}ms)`}`]);
			});
		});
		this.later(task.id, 700 * (names.length + 1), () => {
			const current = engine.getTask(task.id);
			if (current?.pr?.simulated) {
				engine.reportPullRequest(task.id, { ...current.pr, checks: fail ? 'failure' : 'success', checksPassed: fail ? 3 : 4, checksTotal: 4 });
			}
			engine.reportRunResult(task.id, attempt, fail
				? { ok: false, detail: `${this.area(task)}.dedupe / ${this.area(task)}.restore が失敗`, log: ['', `  ${names.length - 2} passing, 2 failing`] }
				: { ok: true, log: ['', `  ${names.length} passing`] });
		});
	}

	/** 外部待ちの工程にいるシミュレーションの PR に、しばらくしてから結果を出す。 */
	onEngineChange(): void {
		const engine = this.engine;
		for (const task of engine.getTasks()) {
			const step = engine.flowOf(task).steps.find(s => s.id === task.step);
			const key = `${task.id}:${task.attempt}`;
			if (task.status !== 'waiting' || step?.kind !== 'wait' || !task.pr?.simulated || this.waitScheduled.has(key)) {
				continue;
			}
			this.waitScheduled.add(key);
			this.later(task.id, step.wait === 'review' ? 4500 : 5000, () => {
				const current = engine.getTask(task.id);
				if (!current?.pr || current.attempt !== task.attempt) {
					return;
				}
				engine.reportOutput(task.id, [step.wait === 'review' ? '● review-bot がレビューしました（シミュレーション）' : '● チェックが終わりました（シミュレーション）']);
				engine.reportPullRequest(task.id, step.wait === 'review' ? { ...current.pr, review: 'commented' } : { ...current.pr, checks: 'success', checksPassed: 4, checksTotal: 4 });
			});
		}
	}

	/* ---------------- 作業場所 ---------------- */

	prepare(task: ITaskBoardTask, slot: ITaskBoardSlot, branch: string): Promise<{ branch: string; path?: string }> {
		this.engine.reportOutput(task.id, [`● ${slot.name} を準備しています（git fetch・${branch} を作成。シミュレーション）`]);
		// 準備は取り消し（clear）で消さない。エンジンは返却の前に準備の終わりを待つので、必ず終わらせる
		return new Promise(resolve => setTimeout(() => resolve({ branch, path: slot.path || undefined }), Math.max(30, 700 / this.speed)));
	}

	release(): Promise<void> {
		return Promise.resolve();
	}

	/* ---------------- フロー外のエージェント ---------------- */

	private tickManual(): void {
		const main = this.manual.find(m => m.id === 'm-main');
		if (main && main.status === 'working') {
			const texts = ['#377 を参照して調べています', 'ログを読んでいます', 'テストを走らせています', '原因の候補を 2 つに絞りました'];
			const next = texts[(texts.indexOf(main.text) + 1) % texts.length];
			Object.assign(main, { text: next });
			this.options.onManualChange();
		}
	}

	answerManual(sessionId: string, allow: boolean): void {
		const session = this.manual.find(m => m.id === sessionId);
		if (!session || session.status !== 'permission') {
			throw new Error('the session is not waiting for permission');
		}
		Object.assign(session, { status: 'working', text: allow ? '許可しました。続きを進めています' : '拒否しました。別の方法を探しています', since: Date.now() });
		this.options.onManualChange();
		setTimeout(() => {
			Object.assign(session, { status: 'permission', text: '許可: Bash: scripts/test.sh --grep tab', since: Date.now() });
			this.options.onManualChange();
		}, 45000 / this.speed);
	}

	removeManual(sessionId: string): ITaskBoardManualSession | undefined {
		const index = this.manual.findIndex(m => m.id === sessionId);
		return index >= 0 ? this.manual.splice(index, 1)[0] : undefined;
	}

	/* ---------------- 詳細（GitHub に無いもの） ---------------- */

	issueDetail(task: ITaskBoardTask): ITaskBoardIssueDetail {
		return {
			title: task.title,
			body: task.body ?? '',
			url: task.issue?.url ?? '',
			state: 'open',
			author: task.source === 'github' ? 'teammate-a' : 'you',
			createdAt: new Date(task.createdAt).toISOString(),
			comments: [...(this.comments.get(`issue:${task.id}`) ?? [])],
			events: [],
			linkedPrs: [],
			simulated: true,
		};
	}

	addComment(task: ITaskBoardTask, target: 'issue' | 'pr', body: string): ITaskBoardComment {
		const comment: ITaskBoardComment = { id: `sim-${Date.now()}`, author: 'you', body, createdAt: new Date().toISOString() };
		const key = `${target}:${task.id}`;
		this.comments.set(key, [...(this.comments.get(key) ?? []), comment]);
		return comment;
	}

	pullDetail(task: ITaskBoardTask): ITaskBoardPullDetail | undefined {
		const pr = task.pr;
		if (!pr) {
			return undefined;
		}
		const area = this.area(task);
		const failing = task.status === 'failed' || pr.checks === 'failure';
		const checks: ITaskBoardCheck[] = [
			{ name: 'build', state: 'success', detail: 'macOS arm64', durationSec: 252 },
			{ name: 'unit-tests', state: 'success', detail: 'scripts/test.sh', durationSec: 400 },
			{ name: 'review-bot', state: pr.review === 'none' ? 'pending' : 'success', detail: 'AI レビュー', durationSec: pr.review === 'none' ? undefined : 65 },
			{ name: 'e2e', state: pr.checks === 'success' ? 'success' : failing ? 'failure' : pr.review === 'none' ? 'queued' : 'pending', detail: 'scripts/test-integration.sh', durationSec: pr.checks === 'pending' ? undefined : 571 },
		];
		const now = Date.now();
		return {
			number: pr.number, title: pr.title ?? task.title, url: '', state: pr.state, author: task.agent === 'codex' ? 'codex' : 'claude',
			body: `${task.title}。${task.issue ? `Closes #${task.issue.number}` : ''}\n\n## 確かめたこと\n\n- 関係する単体テストを追加して通過\n- 変更した画面のスクショを添付`,
			base: 'main', head: task.branch ?? 'para/task', additions: 154, deletions: 18, createdAt: new Date(now - 40 * 60000).toISOString(),
			mergeable: 'mergeable', reviewDecision: pr.review === 'approved' ? 'approved' : 'none',
			comments: [...(this.comments.get(`pr:${task.id}`) ?? [])],
			commits: [
				{ sha: 'a41c9e2', message: `para: ${task.title}`, author: task.agent ?? 'claude', at: new Date(now - 42 * 60000).toISOString() },
				{ sha: '7be0d13', message: 'para: add tests for the new behaviour', author: task.agent ?? 'claude', at: new Date(now - 31 * 60000).toISOString() },
				{ sha: 'c0f5a88', message: 'para: address review comments', author: 'codex', at: new Date(now - 18 * 60000).toISOString() },
			],
			checks,
			reviews: pr.review === 'none' ? [] : [{ author: 'review-bot', state: pr.review === 'changes' ? 'changes' : pr.review === 'approved' ? 'approved' : 'commented', body: '空白の扱いを 1 か所確認してください。それ以外に指摘はありません。', at: new Date(now - 10 * 60000).toISOString(), isBot: true }],
			threads: pr.review === 'none' ? [] : [{ path: `src/vs/paradis/contrib/${area}/common/paradis${area}.ts`, line: 42, author: 'review-bot', body: '末尾の空白だけでなく、先頭の空白の違いも同じ行として扱うべきか確認してください。', diffHunk: '@@ -38,6 +38,8 @@\n \tdedupe(lines: readonly string[]): string[] {\n-\t\tfor (const line of lines) {\n+\t\tfor (const raw of lines) {\n+\t\t\tconst line = raw.trimEnd();', resolved: false }],
			files: [
				{ path: `src/vs/paradis/contrib/${area}/common/paradis${area}.ts`, additions: 64, deletions: 18, status: 'modified' },
				{ path: `src/vs/paradis/contrib/${area}/test/common/paradis${area}.test.ts`, additions: 88, deletions: 0, status: 'added' },
				{ path: 'src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md', additions: 1, deletions: 0, status: 'modified' },
				{ path: 'src/vs/paradis/paradis.common.contribution.ts', additions: 1, deletions: 0, status: 'modified' },
			],
			simulated: true,
		};
	}

	pullFilePatch(task: ITaskBoardTask, file: string): string | undefined {
		if (!task.pr?.simulated) {
			return undefined;
		}
		if (file.endsWith('.test.ts')) {
			return '@@ -0,0 +1,12 @@\n+suite(\'dedupe\', () => {\n+\ttest(\'keeps the first of duplicated lines\', () => {\n+\t\tassert.deepStrictEqual(dedupe([\'a\', \'b\', \'a \']), [\'a\', \'b\']);\n+\t});\n+});';
		}
		if (file.endsWith('.md') || file.endsWith('contribution.ts')) {
			return '@@ -10,6 +10,7 @@\n \n ## 未リリース\n \n+- 変更の内容を 1 行で書く';
		}
		return '@@ -38,12 +38,16 @@ export class ParadisDedupe {\n \tdedupe(lines: readonly string[]): string[] {\n \t\tconst seen = new Set<string>();\n \t\tconst result: string[] = [];\n-\t\tfor (const line of lines) {\n+\t\tfor (const raw of lines) {\n+\t\t\tconst line = raw.trimEnd();\n \t\t\tif (seen.has(line)) {\n \t\t\t\tcontinue;\n \t\t\t}\n+\t\t\tseen.add(line);\n+\t\t\tresult.push(raw);\n \t\t}\n \t\treturn result;\n \t}';
	}
}
