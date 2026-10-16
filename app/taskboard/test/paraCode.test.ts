// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ITaskBoardFlow, ITaskBoardSlot, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TaskBoardEngine, type ITaskBoardRunPort, type ITaskBoardWorkspacePort } from '@engine/paradisTaskBoardEngine.js';
import { ParaCodeAgents, type ParaCodeBridgeEvent } from '../server/paraCode.js';
import { CommandRunner } from '../server/runner.js';

/* Para Code の bridge の代わり。届いた要求を記録し、SSE でイベントを流せる。 */
class FakeBridge {
	readonly requests: { route: string; body: Record<string, unknown> }[] = [];
	readonly replies: Record<string, unknown>[] = [];
	private readonly streams = new Set<http.ServerResponse>();
	private server!: http.Server;
	sendBusy = false;
	/** /v1/events の応答の頭を返さない（起動途中で固まった Para Code の代わり）。 */
	hangEvents = 0;
	/** 起動の返事を遅らせる・失敗させる。 */
	launchDelayMs = 0;
	launchFail = false;
	terminals: { terminal: string; launchId: string; tag?: string; agent: string; status: string }[] = [];
	/** 接続直後に流す報告（shared process が溜めていたもの）。 */
	queuedOnConnect: ParaCodeBridgeEvent[] = [];
	private seq = 0;
	file!: string;

	async start(dir: string): Promise<void> {
		this.server = http.createServer((req, res) => {
			if (req.headers.authorization !== 'Bearer secret') {
				res.writeHead(401).end('{}');
				return;
			}
			const url = new URL(req.url ?? '/', 'http://x');
			if (url.pathname === '/v1/events' && this.hangEvents > 0) {
				this.hangEvents--;
				return;
			}
			if (url.pathname === '/v1/events') {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write(': hello\n\n');
				for (const event of this.queuedOnConnect.splice(0)) {
					res.write(`data: ${JSON.stringify(event)}\n\n`);
				}
				this.streams.add(res);
				req.on('close', () => this.streams.delete(res));
				return;
			}
			if (url.pathname === '/v1/terminals') {
				res.end(JSON.stringify({ terminals: this.terminals }));
				return;
			}
			let raw = '';
			req.on('data', c => raw += c);
			req.on('end', () => {
				const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
				this.requests.push({ route: url.pathname, body });
				if (url.pathname === '/v1/launch' && (this.launchDelayMs || this.launchFail)) {
					setTimeout(() => {
						if (this.launchFail) {
							res.writeHead(500).end(JSON.stringify({ error: 'launch-failed', message: '起動に失敗' }));
						} else {
							const terminal = `t_${++this.seq}`;
							this.terminals.push({ terminal, launchId: String(body.launchId), agent: String(body.agent), status: 'working' });
							res.end(JSON.stringify({ terminal }));
						}
					}, this.launchDelayMs);
				} else if (url.pathname === '/v1/launch') {
					const terminal = `t_${++this.seq}`;
					this.terminals.push({ terminal, launchId: String(body.launchId), agent: String(body.agent), status: 'working' });
					res.end(JSON.stringify({ terminal }));
				} else if (url.pathname === '/v1/send' && !this.sendBusy && body.tag) {
					const entry = this.terminals.find(t => t.terminal === body.terminal);
					if (entry) {
						entry.tag = String(body.tag);
					}
					res.end('{"ok":true}');
				} else if (url.pathname === '/v1/send' && this.sendBusy) {
					res.writeHead(409).end(JSON.stringify({ error: 'busy', message: 'working' }));
				} else {
					if (url.pathname === '/v1/reply') {
						this.replies.push(body);
					}
					res.end('{"ok":true}');
				}
			});
		});
		await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
		const port = (this.server.address() as { port: number }).port;
		this.file = path.join(dir, 'paradis-taskboard-bridge.json');
		writeFileSync(this.file, JSON.stringify({ version: 1, port, token: 'secret', pid: process.pid }));
	}

	emit(event: ParaCodeBridgeEvent): void {
		for (const s of this.streams) {
			s.write(`data: ${JSON.stringify(event)}\n\n`);
		}
	}

	/** Para Code の再起動の代わり。SSE を切る（ボードはつなぎ直して一覧を取り直す）。 */
	dropStreams(): void {
		for (const s of this.streams) {
			s.end();
		}
		this.streams.clear();
	}

	get connected(): number {
		return this.streams.size;
	}

	routes(): string[] {
		return this.requests.map(r => r.route);
	}

	stop(): void {
		for (const s of this.streams) {
			s.end();
		}
		this.server.close();
	}
}

class NoopPorts implements ITaskBoardRunPort, ITaskBoardWorkspacePort {
	run(): void { }
	cancel(): void { }
	prepare(_t: ITaskBoardTask, _s: ITaskBoardSlot, branch: string) {
		return Promise.resolve({ branch });
	}
	release(): Promise<void> {
		return Promise.resolve();
	}
}

const FLOW: ITaskBoardFlow = {
	id: 'f',
	name: 'f',
	scope: 'shared',
	intake: { source: 'none' },
	workspace: { kind: 'clone-pool', releaseOn: 'done', maxRunning: 2 },
	steps: [
		{ id: 'plan', name: '計画', kind: 'agent', agent: 'claude', prompt: '{issue} を計画して' },
		{ id: 'build', name: '実装', kind: 'agent', agent: 'claude', prompt: '実装して' },
		{ id: 'test', name: 'テスト', kind: 'run', run: 'command', command: 'echo ok && exit 3' },
	],
} as unknown as ITaskBoardFlow;

async function until(fn: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) {
			throw new Error('timed out');
		}
		await new Promise(r => setTimeout(r, 10));
	}
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) {
		cleanups.pop()!();
	}
});

async function setup(useRunner = false, hangEvents = 0) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-bridge-'));
	const place = path.join(dir, 'clone');
	mkdirSync(place);
	writeFileSync(path.join(place, 'plan.md'), '# 計画\n- やること');
	const bridge = new FakeBridge();
	await bridge.start(dir);
	bridge.hangEvents = hangEvents;
	let engine!: TaskBoardEngine;
	const placePath = (task: ITaskBoardTask) => engine.getSlots().find(s => s.id === task.place)?.path;
	const agents = new ParaCodeAgents({ engine: () => engine, placePath, bridgeFile: bridge.file, timeouts: { connect: 300, idle: 2000, retry: 100, reconcile: 100, stall: 50 } });
	const noop = new NoopPorts();
	const runner = useRunner ? new CommandRunner({ engine: () => engine, placePath, repoPath: place, repo: undefined }) : noop;
	let seq = 0;
	engine = new TaskBoardEngine({ clock: Date.now, newId: () => `id${++seq}`, agents, runner, workspaces: noop });
	engine.setFlows([FLOW], 'f', true);
	engine.setPoolSlots([{ id: 's1', name: 'clone', path: place, kind: 'clone-pool' }]);
	engine.onDidChange(() => agents.onEngineChange());
	agents.start();
	await until(() => bridge.connected === 1);
	cleanups.push(() => {
		agents.dispose();
		bridge.stop();
		rmSync(dir, { recursive: true, force: true });
	});
	const id = engine.addTask({ title: 'タブ名' });
	return { engine, bridge, id, place, agents };
}

describe('ParaCodeAgents', () => {
	test('launches in the workspace, carries the next agent step into the same terminal, and reads artifacts from files', async () => {
		const { engine, bridge, id, place } = await setup();
		engine.start(id, { agent: 'claude' });
		await until(() => bridge.routes().includes('/v1/launch'));
		const launch = bridge.requests.find(r => r.route === '/v1/launch')!.body;
		expect({ repoPath: launch.repoPath, agent: launch.agent, launchId: launch.launchId }).toEqual({ repoPath: place, agent: 'claude', launchId: `${id}:1` });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));

		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		bridge.emit({ type: 'tool', terminal: 't_1', name: 'Read', detail: 'src/a.ts' });
		await until(() => engine.getTask(id)!.activities.some(a => a.kind === 'tool' && a.label === 'Read'));

		// 報告はターンの途中で届く。次の工程（同じ claude）の指示はターンが終わるまで預かる
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'r1', tool: 'complete_step', args: { summary: '計画を書いた', artifacts: [{ kind: 'plan', title: '計画', path: 'plan.md' }] } });
		await until(() => bridge.replies.length === 1);
		const task = engine.getTask(id)!;
		expect({ step: task.step, reply: bridge.replies[0].ok, artifact: task.artifacts[0]?.content, sends: bridge.routes().filter(r => r === '/v1/send').length })
			.toEqual({ step: 'build', reply: true, artifact: '# 計画\n- やること', sends: 0 });
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		await until(() => bridge.routes().includes('/v1/send'));
		expect(bridge.requests.find(r => r.route === '/v1/send')!.body).toMatchObject({ terminal: 't_1', submit: true });
		expect(String(bridge.requests.find(r => r.route === '/v1/send')!.body.text)).toContain('実装して');
		expect(engine.getTask(id)!.status).toBe('working');
	});

	test('ask_human becomes a board question whose answer is sent as the next prompt; TUI questions are answered by option index', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'q1', tool: 'ask_human', args: { question: 'タブで分ける？', options: ['分ける', 'まとめる'] } });
		await until(() => engine.getTask(id)!.status === 'question');
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		const q = engine.getTask(id)!.question!;
		engine.answer(id, q.id, { optionIndex: 1 });
		await until(() => bridge.routes().includes('/v1/send'));
		expect(bridge.requests.find(r => r.route === '/v1/send')!.body.text).toBe('まとめる');

		// 画面の質問（Claude Code の AskUserQuestion など）は /v1/answer で選択肢の番号を送る
		bridge.emit({ type: 'status', terminal: 't_1', status: 'permission', question: { text: 'Bash: npm test', options: [{ label: 'Yes' }, { label: 'No' }], allowText: false } });
		await until(() => engine.getTask(id)!.status === 'permission');
		engine.answer(id, engine.getTask(id)!.question!.id, { optionIndex: 0 });
		await until(() => bridge.routes().includes('/v1/answer'));
		expect(bridge.requests.find(r => r.route === '/v1/answer')!.body).toEqual({ terminal: 't_1', kind: 'permission', optionIndex: 0 });
	});

	test('a permission without options (folder trust) gets allow / deny options and is answered with allow', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));
		bridge.emit({ type: 'status', terminal: 't_1', status: 'permission', question: { text: 'trust?', options: [], allowText: false } });
		await until(() => engine.getTask(id)!.status === 'permission');
		const q = engine.getTask(id)!.question!;
		engine.answer(id, q.id, { optionIndex: 0 });
		await until(() => bridge.routes().includes('/v1/answer'));
		expect({ options: q.options.map(o => o.label), body: bridge.requests.find(r => r.route === '/v1/answer')!.body }).toEqual({ options: ['許可する', '拒否する'], body: { terminal: 't_1', kind: 'permission', allow: true } });
	});

	test('a turn that ends without complete_step stalls the task; exit fails it; cancel closes the terminal', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		await until(() => engine.getTask(id)!.status === 'stalled');
		engine.cancel(id);
		await until(() => bridge.routes().includes('/v1/close'));
		expect(engine.getTask(id)!.step).toBe('todo');
	});

	test('a moment of idle that turns back to working does not stall the task', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		await new Promise(r => setTimeout(r, 200));
		expect(engine.getTask(id)!.status).toBe('working');
	});

	test('after a retry, complete_step from the interrupted turn is refused until the new prompt is sent', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		await until(() => engine.getTask(id)!.status === 'working');
		engine.retry(id);
		await until(() => bridge.routes().includes('/v1/key'));
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'old', tool: 'complete_step', args: { summary: 'old' } });
		await until(() => bridge.replies.length === 1);
		expect({ ok: bridge.replies[0].ok, step: engine.getTask(id)!.step, launches: bridge.routes().filter(r => r === '/v1/launch').length }).toEqual({ ok: false, step: 'plan', launches: 1 });
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		await until(() => bridge.routes().includes('/v1/send'));
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'new', tool: 'complete_step', args: { summary: 'new' } });
		await until(() => bridge.replies.length === 2);
		expect({ ok: bridge.replies[1].ok, step: engine.getTask(id)!.step }).toEqual({ ok: true, step: 'build' });
	});

	test('artifact paths outside the workspace are refused', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'r', tool: 'complete_step', args: { summary: 'x', artifacts: [{ kind: 'report', title: 'passwd', path: '../../../../../../etc/passwd' }] } });
		await until(() => bridge.replies.length === 1);
		expect({ ok: bridge.replies[0].ok, step: engine.getTask(id)!.step }).toEqual({ ok: false, step: 'plan' });
	});
});

describe('ParaCodeBridgeClient', () => {
	test('reconnects when Para Code accepts the event stream but never answers (for example while it is starting)', async () => {
		const { bridge } = await setup(false, 2);
		expect(bridge.connected).toBe(1);
	});
});

describe('ParaCodeAgents: interruptions', () => {
	const started = (engine: TaskBoardEngine, id: string) => until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));

	test('retrying while the agent waits for a permission keeps the new prompt until the turn ends instead of failing', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await started(engine, id);
		bridge.emit({ type: 'status', terminal: 't_1', status: 'permission', question: { text: 'Bash: rm', options: [{ label: 'Yes' }, { label: 'No' }], allowText: false } });
		await until(() => engine.getTask(id)!.status === 'permission');
		engine.retry(id);
		await until(() => bridge.routes().includes('/v1/key'));
		await new Promise(r => setTimeout(r, 50));
		expect({ sends: bridge.routes().filter(r => r === '/v1/send').length, status: engine.getTask(id)!.status }).toEqual({ sends: 0, status: 'working' });
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		await until(() => bridge.routes().includes('/v1/send'));
		expect(engine.getTask(id)!.status).toBe('working');
	});

	test('a launch that fails after a retry reports the failure on the current attempt', async () => {
		const { engine, bridge, id } = await setup();
		bridge.launchDelayMs = 200;
		bridge.launchFail = true;
		engine.start(id, { agent: 'claude' });
		await until(() => bridge.routes().includes('/v1/launch'));
		engine.retry(id);
		await until(() => engine.getTask(id)!.status === 'failed');
		expect({ attempt: engine.getTask(id)!.attempt, error: engine.getTask(id)!.error }).toEqual({ attempt: 2, error: '起動に失敗' });
	});

	test('a terminal released while it was launching is closed when the late launch returns', async () => {
		const { engine, bridge, id, agents } = await setup();
		bridge.launchDelayMs = 300;
		engine.start(id, { agent: 'claude' });
		await until(() => bridge.routes().includes('/v1/launch'));
		const first = engine.getTask(id)!.attempt;
		await agents.release(engine.getTask(id)!);
		bridge.launchDelayMs = 0;
		engine.retry(id);
		await until(() => bridge.routes().includes('/v1/close'), 3000);
		const late = bridge.terminals.find(t => t.launchId.endsWith(`:${first}`))!.terminal;
		const closed = bridge.requests.filter(r => r.route === '/v1/close').map(r => r.body.terminal);
		expect({ closed, launches: bridge.routes().filter(r => r === '/v1/launch').length }).toEqual({ closed: [late], launches: 2 });
	});

	test('when Para Code restarts and the terminal is gone, the task fails instead of waiting forever', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await started(engine, id);
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		await new Promise(r => setTimeout(r, 30));
		bridge.terminals = [];
		bridge.dropStreams();
		await until(() => engine.getTask(id)!.status === 'failed', 8000);
		expect(engine.getTask(id)!.error).toBe('エージェントが終了しました');
	}, 10000);

	test('after the board restarts, a live terminal is relinked to its task and its current permission shows up', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await started(engine, id);
		// ボードの再起動の代わり: 台帳を保存して、新しいエンジンと口で読み直す
		const saved = engine.serialize();
		let engine2!: TaskBoardEngine;
		const place = engine.getSlots()[0].path;
		const agents2 = new ParaCodeAgents({ engine: () => engine2, placePath: () => place, bridgeFile: bridge.file, timeouts: { connect: 300, idle: 2000, retry: 100, stall: 50 } });
		const noop = new NoopPorts();
		engine2 = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: agents2, runner: noop, workspaces: noop });
		engine2.setFlows([FLOW], 'f', true);
		engine2.setPoolSlots([{ id: 's1', name: 'clone', path: place, kind: 'clone-pool' }]);
		engine2.restore(saved);
		cleanups.push(() => agents2.dispose());
		bridge.terminals[0].status = 'permission';
		agents2.start();
		await until(() => bridge.connected === 2);
		bridge.emit({ type: 'status', terminal: 't_1', launchId: `${id}:1`, status: 'permission', question: { text: 'trust?', options: [], allowText: false } });
		await until(() => engine2.getTask(id)!.question?.text === 'trust?');
		expect({ attempt: engine2.getTask(id)!.attempt, text: engine2.getTask(id)!.question?.text }).toEqual({ attempt: 2, text: 'trust?' });
	});

	test('a turn too short to be reported as working is caught by comparing with the terminal list', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await started(engine, id);
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		bridge.terminals[0].status = 'review';
		// Para Code は短いターンの working を流さず、一覧だけが review になっている
		await until(() => engine.getTask(id)!.status === 'stalled', 3000);
		expect(engine.getTask(id)!.status).toBe('stalled');
	});

	test('a board restart during the second agent step on the same terminal keeps accepting the report of that step, even one queued before the board reconnected', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await started(engine, id);
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'r1', tool: 'complete_step', args: { summary: 'plan' } });
		await until(() => engine.getTask(id)!.step === 'build');
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		await until(() => bridge.terminals[0].tag === `${id}:2`);
		// 実装の作業中にボードが落ち、その間にエージェントが報告した（shared process が溜めている）
		const saved = engine.serialize();
		let engine2!: TaskBoardEngine;
		const place = engine.getSlots()[0].path;
		const agents2 = new ParaCodeAgents({ engine: () => engine2, placePath: () => place, bridgeFile: bridge.file, timeouts: { connect: 300, idle: 2000, retry: 100, reconcile: 100, stall: 50 } });
		const noop = new NoopPorts();
		engine2 = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: agents2, runner: noop, workspaces: noop });
		engine2.setFlows([FLOW], 'f', true);
		engine2.setPoolSlots([{ id: 's1', name: 'clone', path: place, kind: 'clone-pool' }]);
		engine2.restore(saved);
		cleanups.push(() => agents2.dispose());
		bridge.queuedOnConnect.push({ type: 'report', terminal: 't_1', replyId: 'r2', tool: 'complete_step', args: { summary: 'built' } });
		agents2.start();
		await until(() => bridge.replies.some(r => r.replyId === 'r2'));
		expect({ ok: bridge.replies.find(r => r.replyId === 'r2')!.ok, step: engine2.getTask(id)!.step }).toEqual({ ok: true, step: 'test' });
	});

	test('an answer to ask_human given while the agent is still working is sent when the turn ends', async () => {
		const { engine, bridge, id } = await setup();
		engine.start(id, { agent: 'claude' });
		await started(engine, id);
		bridge.emit({ type: 'status', terminal: 't_1', status: 'working' });
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'q', tool: 'ask_human', args: { question: 'どっち？', options: ['A', 'B'] } });
		await until(() => engine.getTask(id)!.status === 'question');
		engine.answer(id, engine.getTask(id)!.question!.id, { optionIndex: 0 });
		await new Promise(r => setTimeout(r, 50));
		expect(bridge.routes().includes('/v1/send')).toBe(false);
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		await until(() => bridge.routes().includes('/v1/send'));
		expect({ text: bridge.requests.find(r => r.route === '/v1/send')!.body.text, status: engine.getTask(id)!.status }).toEqual({ text: 'A', status: 'working' });
	});
});

describe('CommandRunner', () => {
	test('runs the command in the workspace and fails on a non-zero exit code', async () => {
		const { engine, bridge, id } = await setup(true);
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.activities.some(a => a.label.includes('始めました')));
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'r1', tool: 'complete_step', args: { summary: 'a' } });
		await until(() => engine.getTask(id)!.step === 'build');
		bridge.emit({ type: 'status', terminal: 't_1', status: 'idle' });
		await until(() => bridge.routes().includes('/v1/send'));
		bridge.emit({ type: 'report', terminal: 't_1', replyId: 'r2', tool: 'complete_step', args: { summary: 'b' } });
		await until(() => engine.getTask(id)!.status === 'failed');
		const task = engine.getTask(id)!;
		expect({ step: task.step, error: task.error, ok: task.log.some(l => l.trim() === 'ok') }).toEqual({ step: 'test', error: '終了コード 3', ok: true });
	});

	test('draft-pr pushes the branch and creates a draft PR that closes the issue in another repository', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-pr-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const origin = path.join(dir, 'origin.git');
		const work = path.join(dir, 'work');
		const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
		mkdirSync(work);
		run(dir, 'init', '--bare', '-q', origin);
		run(work, 'init', '-q', '-b', 'main');
		run(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
		run(work, 'remote', 'add', 'origin', origin);
		run(work, 'push', '-q', 'origin', 'main');
		run(work, 'fetch', '-q', 'origin');
		run(work, 'switch', '-q', '-c', 'para/7-x');
		run(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x');
		const bin = path.join(dir, 'bin');
		mkdirSync(bin);
		const log = path.join(dir, 'gh.log');
		writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$2" in list) echo '[]';; create) echo 'https://github.com/o/code/pull/42';; esac\n`);
		chmodSync(path.join(bin, 'gh'), 0o755);

		const flow = { ...FLOW, steps: [{ id: 'pr', name: 'PR', kind: 'run', run: 'draft-pr' }] } as unknown as ITaskBoardFlow;
		let engine!: TaskBoardEngine;
		const runner = new CommandRunner({ engine: () => engine, placePath: () => work, repoPath: work, repo: { owner: 'o', repo: 'code' }, env: { PATH: `${bin}:${process.env.PATH}` } });
		engine = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: { startStep() { }, answer() { }, sendInput() { }, sendKey() { }, stop() { } }, runner, workspaces: { prepare: (_t, _s, branch) => Promise.resolve({ branch: 'para/7-x' }), release: () => Promise.resolve() } });
		engine.setFlows([flow], 'f', true);
		engine.setPoolSlots([{ id: 's1', name: 'w', path: work, kind: 'clone-pool' }]);
		engine.syncIntake([{ issue: { owner: 'o', repo: 'issues', number: 7, url: '' }, title: 'X', labels: [], assignees: [] }]);
		engine.start('gh:o/issues#7', { agent: 'claude' });
		await until(() => engine.getTask('gh:o/issues#7')!.pr !== undefined, 4000);
		const calls = readFileSync(log, 'utf8');
		expect({
			pr: engine.getTask('gh:o/issues#7')!.pr?.number,
			pushed: run(origin, 'branch', '--list', 'para/7-x').toString().trim(),
			create: calls.includes('pr create --repo o/code --head para/7-x --draft --title=X --body=Closes o/issues#7'),
		}).toEqual({ pr: 42, pushed: 'para/7-x', create: true });
	}, 20000);

	test('draft-pr pushes new commits to an existing PR instead of skipping them', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-pr-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const origin = path.join(dir, 'origin.git');
		const work = path.join(dir, 'work');
		const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
		mkdirSync(work);
		run(dir, 'init', '--bare', '-q', origin);
		run(work, 'init', '-q', '-b', 'main');
		run(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
		run(work, 'remote', 'add', 'origin', origin);
		run(work, 'push', '-q', 'origin', 'main');
		run(work, 'fetch', '-q', 'origin');
		run(work, 'switch', '-q', '-c', 'para/7-x');
		run(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
		run(work, 'push', '-q', 'origin', 'para/7-x');
		run(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'rework');
		const bin = path.join(dir, 'bin');
		mkdirSync(bin);
		const log = path.join(dir, 'gh.log');
		writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$2" in list) echo '[{"number":42,"url":"https://github.com/o/code/pull/42","title":"X","isDraft":true}]';; create) echo 'https://github.com/o/code/pull/43';; esac\n`);
		chmodSync(path.join(bin, 'gh'), 0o755);
		const flow = { ...FLOW, steps: [{ id: 'pr', name: 'PR', kind: 'run', run: 'draft-pr' }] } as unknown as ITaskBoardFlow;
		let engine!: TaskBoardEngine;
		const runner = new CommandRunner({ engine: () => engine, placePath: () => work, repoPath: work, repo: { owner: 'o', repo: 'code' }, env: { PATH: `${bin}:${process.env.PATH}` } });
		engine = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: { startStep() { }, answer() { }, sendInput() { }, sendKey() { }, stop() { } }, runner, workspaces: { prepare: () => Promise.resolve({ branch: 'para/7-x' }), release: () => Promise.resolve() } });
		engine.setFlows([flow], 'f', true);
		engine.setPoolSlots([{ id: 's1', name: 'w', path: work, kind: 'clone-pool' }]);
		engine.syncIntake([{ issue: { owner: 'o', repo: 'issues', number: 7, url: '' }, title: 'X', labels: [], assignees: [] }]);
		const id = 'gh:o/issues#7';
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.pr !== undefined, 10000);
		expect({
			pr: engine.getTask(id)!.pr?.number,
			remoteHead: run(origin, 'log', '-1', '--format=%s', 'para/7-x').toString().trim(),
			created: readFileSync(log, 'utf8').includes('pr create'),
		}).toEqual({ pr: 42, remoteHead: 'rework', created: false });
	}, 20000);

	const prAfterRemoteMoved = async (localCommit: boolean) => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-pr-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const origin = path.join(dir, 'origin.git');
		const work = path.join(dir, 'work');
		const other = path.join(dir, 'other');
		const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
		const commit = (cwd: string, m: string) => run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', m);
		mkdirSync(work);
		run(dir, 'init', '--bare', '-q', origin);
		run(work, 'init', '-q', '-b', 'main');
		commit(work, 'base');
		run(work, 'remote', 'add', 'origin', origin);
		run(work, 'push', '-q', 'origin', 'main');
		run(work, 'fetch', '-q', 'origin');
		run(work, 'switch', '-q', '-c', 'para/7-x');
		commit(work, 'first');
		run(work, 'push', '-q', 'origin', 'para/7-x');
		// 別の場所（GitHub の Update branch の代わり）でリモートのブランチだけを進める
		run(dir, 'clone', '-q', '-b', 'para/7-x', origin, other);
		commit(other, 'remote only');
		run(other, 'push', '-q', 'origin', 'para/7-x');
		if (localCommit) {
			commit(work, 'local');
		}
		const bin = path.join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$2" in list) echo '[{"number":42,"url":"https://github.com/o/code/pull/42","title":"X","isDraft":true}]';; esac\n`);
		chmodSync(path.join(bin, 'gh'), 0o755);
		const flow = { ...FLOW, steps: [{ id: 'pr', name: 'PR', kind: 'run', run: 'draft-pr' }] } as unknown as ITaskBoardFlow;
		let engine!: TaskBoardEngine;
		const runner = new CommandRunner({ engine: () => engine, placePath: () => work, repoPath: work, repo: { owner: 'o', repo: 'code' }, env: { PATH: `${bin}:${process.env.PATH}` } });
		engine = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: { startStep() { }, answer() { }, sendInput() { }, sendKey() { }, stop() { } }, runner, workspaces: { prepare: () => Promise.resolve({ branch: 'para/7-x' }), release: () => Promise.resolve() } });
		engine.setFlows([flow], 'f', true);
		engine.setPoolSlots([{ id: 's1', name: 'w', path: work, kind: 'clone-pool' }]);
		engine.syncIntake([{ issue: { owner: 'o', repo: 'issues', number: 7, url: '' }, title: 'X', labels: [], assignees: [] }]);
		const id = 'gh:o/issues#7';
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.pr !== undefined || engine.getTask(id)!.status === 'failed', 10000);
		return { pr: engine.getTask(id)!.pr?.number, error: engine.getTask(id)!.error, remoteHead: run(origin, 'log', '-1', '--format=%s', 'para/7-x').toString().trim() };
	};

	test('draft-pr reuses an existing PR without pushing when only the remote moved', async () => {
		expect(await prAfterRemoteMoved(false)).toEqual({ pr: 42, error: undefined, remoteHead: 'remote only' });
	}, 20000);

	test('draft-pr stops with a clear message when both the remote and the place moved', async () => {
		expect(await prAfterRemoteMoved(true)).toEqual({ pr: undefined, error: 'リモートの para/7-x に、手元に無いコミットが 1 件あります。取り込んでからやり直してください', remoteHead: 'remote only' });
	}, 20000);

	test('draft-pr stops before push when the place has uncommitted changes or no commits of its own', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-pr-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const origin = path.join(dir, 'origin.git');
		const work = path.join(dir, 'work');
		const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
		mkdirSync(work);
		run(dir, 'init', '--bare', '-q', origin);
		run(work, 'init', '-q', '-b', 'main');
		run(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
		run(work, 'remote', 'add', 'origin', origin);
		run(work, 'push', '-q', 'origin', 'main');
		run(work, 'fetch', '-q', 'origin');
		run(work, 'switch', '-q', '-c', 'para/7-x');
		mkdirSync(path.join(work, '.para'));
		writeFileSync(path.join(work, '.para', 'plan.md'), 'plan');
		writeFileSync(path.join(work, 'a.txt'), 'a');
		const bin = path.join(dir, 'bin');
		mkdirSync(bin);
		const log = path.join(dir, 'gh.log');
		writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$2" in list) echo '[]';; create) echo 'https://github.com/o/code/pull/42';; esac\n`);
		chmodSync(path.join(bin, 'gh'), 0o755);
		const flow = { ...FLOW, steps: [{ id: 'pr', name: 'PR', kind: 'run', run: 'draft-pr' }] } as unknown as ITaskBoardFlow;
		let engine!: TaskBoardEngine;
		const runner = new CommandRunner({ engine: () => engine, placePath: () => work, repoPath: work, repo: { owner: 'o', repo: 'code' }, env: { PATH: `${bin}:${process.env.PATH}` } });
		engine = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: { startStep() { }, answer() { }, sendInput() { }, sendKey() { }, stop() { } }, runner, workspaces: { prepare: () => Promise.resolve({ branch: 'para/7-x' }), release: () => Promise.resolve() } });
		engine.setFlows([flow], 'f', true);
		engine.setPoolSlots([{ id: 's1', name: 'w', path: work, kind: 'clone-pool' }]);
		engine.syncIntake([{ issue: { owner: 'o', repo: 'issues', number: 7, url: '' }, title: 'X', labels: [], assignees: [] }]);
		const id = 'gh:o/issues#7';
		engine.start(id, { agent: 'claude' });
		await until(() => engine.getTask(id)!.status === 'failed', 10000);
		const dirty = { uncommitted: engine.getTask(id)!.uncommitted };
		rmSync(path.join(work, 'a.txt'));
		engine.retry(id);
		await until(() => engine.getTask(id)!.status === 'failed' && !engine.getTask(id)!.uncommitted, 10000);
		expect({ ...dirty, error: engine.getTask(id)!.error, pushed: run(origin, 'branch', '--list', 'para/7-x').toString().trim(), ghCreate: existsSync(log) && readFileSync(log, 'utf8').includes('pr create') }).toEqual({
			uncommitted: ['a.txt'],
			error: 'origin/main より先のコミットがありません',
			pushed: '',
			ghCreate: false,
		});
	}, 20000);

	test('cancelling while draft-pr is checking for an existing PR stops before push and create', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-pr-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		execFileSync('git', ['init', '-q', '-b', 'para/1-x'], { cwd: dir });
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });
		const bin = path.join(dir, 'bin');
		mkdirSync(bin);
		const log = path.join(dir, 'gh.log');
		writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$2" in list) sleep 2; echo '[]';; create) echo 'https://github.com/o/code/pull/42';; esac\n`);
		chmodSync(path.join(bin, 'gh'), 0o755);
		const flow = { ...FLOW, steps: [{ id: 'pr', name: 'PR', kind: 'run', run: 'draft-pr' }] } as unknown as ITaskBoardFlow;
		let engine!: TaskBoardEngine;
		const runner = new CommandRunner({ engine: () => engine, placePath: () => dir, repoPath: dir, repo: { owner: 'o', repo: 'code' }, env: { PATH: `${bin}:${process.env.PATH}` } });
		engine = new TaskBoardEngine({ clock: Date.now, newId: () => Math.random().toString(36).slice(2), agents: { startStep() { }, answer() { }, sendInput() { }, sendKey() { }, stop() { } }, runner, workspaces: { prepare: (_t, _s, branch) => Promise.resolve({ branch }), release: () => Promise.resolve() } });
		engine.setFlows([flow], 'f', true);
		engine.setPoolSlots([{ id: 's1', name: 'w', path: dir, kind: 'clone-pool' }]);
		const id = engine.addTask({ title: 'X' });
		engine.start(id, { agent: 'claude' });
		await until(() => { try { return readFileSync(log, 'utf8').includes('pr list'); } catch { return false; } });
		engine.cancel(id);
		await new Promise(r => setTimeout(r, 2500));
		expect({ step: engine.getTask(id)!.step, calls: readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' ').slice(0, 2).join(' ')) }).toEqual({ step: 'todo', calls: ['pr list'] });
	}, 20000);
});
