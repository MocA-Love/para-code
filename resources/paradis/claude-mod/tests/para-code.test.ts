/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Run with `claude plugin test <a copy of this folder>`: the engine lays its types and a tsconfig
// into the folder it tests, so test a copy (see NOTES.md, "Claude Mods").

import type { On } from 'claude-code';
import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing';

type Json = Record<string, unknown>;

interface IRecorded {
	readonly op: string;
	readonly body: Json;
}

const PORT_FILE = '/para-code-test/paradis-browser-mcp.json';

const QUESTIONS = [{
	question: 'Pick a color?',
	header: 'Color',
	multiSelect: false,
	options: [{ label: 'Red', description: '' }, { label: 'Green', description: '' }],
}];

/** Para Code as the mod sees it: the pane's environment, the port file and the loopback endpoint. */
function fakeParaCode(on: On, handlers: Readonly<Record<string, (body: Json) => Json | Promise<Json>>>, recorded: IRecorded[], withPane = true, sessionId: () => string = () => 'session-1'): MockClock {
	mock.env(on, withPane ? { PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: PORT_FILE } : {});
	// Holds the command loop's timer: the tests drive the hooks, and move the clock to run the loop.
	const clock = mock.clock(on);
	on('fs.read', ($, e) => e.path === PORT_FILE ? { value: '{"port":47999}' } : { deny: 'no such file' });
	on('session.id', () => ({ value: sessionId() }));
	on('session.start', ($, e) => ({ cwd: e.cwd }));
	on('http.fetch', async ($, e) => {
		const op = e.url.slice(e.url.lastIndexOf('/') + 1);
		const body = JSON.parse(e.init?.body ?? '{}') as Json;
		recorded.push({ op, body });
		const handler = handlers[op];
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(handler !== undefined ? await handler(body) : {}) } };
	});
	return clock;
}

async function startSession($: Engine): Promise<void> {
	await $.session.start({ cwd: '/para-code-test', surface: 'terminal', isInteractive: true });
}

describe('para-code mod', () => {
	test('outside a Para Code terminal every hook passes through untouched', async ($, on) => {
		const recorded: IRecorded[] = [];
		fakeParaCode(on, {}, recorded, false);
		on('classic.PermissionRequest', () => ({}));
		await startSession($);
		const decided = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'touch a' } });
		expect(decided).toEqual({});
		expect(recorded).toEqual([]);
	});

	test('an answer from the phone becomes the AskUserQuestion result', async ($, on) => {
		const recorded: IRecorded[] = [];
		fakeParaCode(on, {
			question: () => ({ id: 'q1', wait: true }),
			wait: () => ({ state: 'answer', answers: { 'Pick a color?': 'Green' } }),
		}, recorded);
		let releaseTerminal: (() => void) | undefined;
		// The terminal's own dialog stays open until the test is done.
		on('tool.call', () => new Promise(resolve => {
			releaseTerminal = () => resolve({ result: { questions: QUESTIONS, answers: { 'Pick a color?': 'Red' } } });
		}));
		await startSession($);
		const answered = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS });
		releaseTerminal?.();
		expect(answered.result).toEqual({ questions: QUESTIONS, answers: { 'Pick a color?': 'Green' } });
		expect(recorded.find(entry => entry.op === 'question')?.body).toEqual(expect.objectContaining({ sessionId: 'session-1', questions: QUESTIONS }));
	});

	test('notes from the phone come back as annotations next to the answer', async ($, on) => {
		const recorded: IRecorded[] = [];
		const annotations = { 'Pick a color?': { preview: '# Green', notes: 'a darker one' } };
		fakeParaCode(on, {
			question: () => ({ id: 'q4', wait: true }),
			wait: () => ({ state: 'answer', answers: { 'Pick a color?': 'Green' }, annotations }),
		}, recorded);
		let releaseTerminal: (() => void) | undefined;
		on('tool.call', () => new Promise(resolve => {
			releaseTerminal = () => resolve({ result: { questions: QUESTIONS, answers: { 'Pick a color?': 'Red' } } });
		}));
		await startSession($);
		const answered = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS });
		releaseTerminal?.();
		expect(answered.result).toEqual({ questions: QUESTIONS, answers: { 'Pick a color?': 'Green' }, annotations });
	});

	test('"Chat about this" from the phone: a message becomes the response, no message the refusal Para Code wrote', async ($, on) => {
		const recorded: IRecorded[] = [];
		const replies = [
			{ state: 'clarify', response: 'show me the screen first' },
			{ state: 'clarify', deny: 'The user wants to clarify these questions.' },
		];
		fakeParaCode(on, {
			question: () => ({ id: 'q5', wait: true }),
			wait: () => replies.shift() ?? { state: 'settled' },
		}, recorded);
		const releases: (() => void)[] = [];
		on('tool.call', () => new Promise(resolve => {
			releases.push(() => resolve({ result: { questions: QUESTIONS, answers: { 'Pick a color?': 'Red' } } }));
		}));
		await startSession($);
		const withMessage = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS });
		const withoutMessage = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS });
		for (const release of releases) {
			release();
		}
		expect({ withMessage: withMessage.result, withoutMessage: (withoutMessage as Json).deny }).toEqual({
			withMessage: { questions: QUESTIONS, answers: {}, response: 'show me the screen first' },
			withoutMessage: 'The user wants to clarify these questions.',
		});
	});

	test('an answer in the terminal wins and tells Para Code to stop waiting', async ($, on) => {
		const recorded: IRecorded[] = [];
		const settled = new Set<string>();
		fakeParaCode(on, {
			question: () => ({ id: 'q2', wait: true }),
			wait: body => ({ state: settled.has(String(body.id)) ? 'settled' : 'pending' }),
			settle: body => {
				for (const id of body.ids as string[]) {
					settled.add(id);
				}
				return {};
			},
		}, recorded);
		on('tool.call', () => ({ result: { questions: QUESTIONS, answers: { 'Pick a color?': 'Red' } } }));
		await startSession($);
		const answered = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS });
		expect(answered.result).toEqual({ questions: QUESTIONS, answers: { 'Pick a color?': 'Red' } });
		expect(recorded.some(entry => entry.op === 'settle' && JSON.stringify(entry.body.ids) === '["q2"]')).toBe(true);
	});

	test('"always allow" from the phone returns the suggested rules', async ($, on) => {
		const recorded: IRecorded[] = [];
		const suggestions = [{ type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'touch a' }], behavior: 'allow' as const, destination: 'session' as const }];
		fakeParaCode(on, {
			permission: () => ({ id: 'p1', wait: true }),
			wait: () => ({ state: 'answer', decision: 'allow', always: true }),
		}, recorded);
		on('classic.PermissionRequest', () => ({}));
		await startSession($);
		const decided = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'touch a' }, permission_suggestions: suggestions });
		expect(decided).toEqual({ decision: { behavior: 'allow', updatedPermissions: suggestions } });
		expect(recorded.find(entry => entry.op === 'permission')?.body).toEqual(expect.objectContaining({ toolName: 'Bash', suggestions }));
	});

	test('a refusal from the phone denies the call', async ($, on) => {
		const recorded: IRecorded[] = [];
		fakeParaCode(on, {
			permission: () => ({ id: 'p2', wait: true }),
			wait: () => ({ state: 'answer', decision: 'deny' }),
		}, recorded);
		on('classic.PermissionRequest', () => ({}));
		await startSession($);
		const decided = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
		expect(decided).toEqual({ decision: { behavior: 'deny', message: 'Denied from Para Code Mobile.' } });
	});

	test('a refusal with an instruction from the phone hands that text to Claude Code, and the mod says it can', async ($, on) => {
		const recorded: IRecorded[] = [];
		const message = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nkeep build, run echo kept';
		fakeParaCode(on, {
			permission: () => ({ id: 'p4', wait: true }),
			wait: () => ({ state: 'answer', decision: 'deny', message }),
		}, recorded);
		on('classic.PermissionRequest', () => ({}));
		await startSession($);
		const decided = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
		expect(decided).toEqual({ decision: { behavior: 'deny', message } });
		expect(recorded.find(entry => entry.op === 'permission')?.body.denyMessage).toBe(true);
	});

	test('when Para Code does not wait (no phone connected) the terminal prompt alone decides', async ($, on) => {
		const recorded: IRecorded[] = [];
		fakeParaCode(on, { permission: () => ({ id: 'p3', wait: false }) }, recorded);
		on('classic.PermissionRequest', () => ({}));
		await startSession($);
		const decided = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } });
		expect(decided).toEqual({});
		expect(recorded.some(entry => entry.op === 'wait')).toBe(false);
	});

	test('a stop from the phone calls TaskStop and acks the outcome', async ($, on) => {
		const recorded: IRecorded[] = [];
		let handed = false;
		const clock = fakeParaCode(on, {
			commands: () => {
				if (handed) {
					return { commands: [] };
				}
				handed = true;
				return { commands: [{ id: 'c1', kind: 'taskStop', taskId: 'b123abc' }, { id: 'c2', kind: 'taskStop', taskId: '../bad' }] };
			},
		}, recorded);
		const stopped: unknown[] = [];
		on('tool.call', ($, e) => {
			stopped.push({ tool: e.tool, task_id: (e as unknown as Json).task_id });
			return { result: { message: 'Successfully stopped task: b123abc (sleep 600)', task_id: 'b123abc', task_type: 'local_bash' } };
		});
		await startSession($);
		await clock.advance(1);
		await clock.settle();
		expect({ stopped, acks: recorded.filter(entry => entry.op === 'ack').map(entry => entry.body) }).toEqual({
			stopped: [{ tool: 'TaskStop', task_id: 'b123abc' }],
			acks: [{ sessionId: 'session-1', id: 'c1', ok: true, message: 'Successfully stopped task: b123abc (sleep 600)' }],
		});
	});

	test('a stop is not held behind a prompt that waits for the running turn to end', async ($, on) => {
		const recorded: IRecorded[] = [];
		const handed: Json[][] = [[{ id: 's1', kind: 'submit', text: 'next please' }], [{ id: 'c1', kind: 'taskStop', taskId: 'b42' }]];
		const clock = fakeParaCode(on, { commands: () => ({ commands: handed.shift() ?? [] }) }, recorded);
		let finishTurn: (() => void) | undefined;
		// The prompt is taken only once the running turn ends (what `$.prompt.submit` does while the agent works).
		on('prompt.submit', ($, e, next) => new Promise(resolve => {
			finishTurn = () => resolve(next(e));
		}));
		const stopped: unknown[] = [];
		on('tool.call', ($, e) => {
			stopped.push((e as unknown as Json).task_id);
			return { result: { message: 'Successfully stopped task: b42', task_id: 'b42', task_type: 'local_bash' } };
		});
		await startSession($);
		for (let i = 0; i < 5; i++) {
			await clock.advance(1);
		}
		const whileWorking = { stopped: [...stopped], acks: recorded.filter(entry => entry.op === 'ack').map(entry => entry.body) };
		finishTurn?.();
		await clock.settle();
		expect(whileWorking).toEqual({
			stopped: ['b42'],
			acks: [{ sessionId: 'session-1', id: 's1', received: true }, { sessionId: 'session-1', id: 'c1', ok: true, message: 'Successfully stopped task: b42' }],
		});
	});

	test('a second prompt handed over while the first is still being submitted is refused, never sent', async ($, on) => {
		const recorded: IRecorded[] = [];
		const handed: Json[][] = [[{ id: 's1', kind: 'submit', text: 'first' }], [{ id: 's2', kind: 'submit', text: 'second' }, { id: 's3', kind: 'submit', text: 'third' }]];
		const clock = fakeParaCode(on, { commands: () => ({ commands: handed.shift() ?? [] }) }, recorded);
		const submitted: string[] = [];
		let finishTurn: (() => void) | undefined;
		on('prompt.submit', ($, e, next) => {
			submitted.push(e.text);
			return new Promise(resolve => {
				finishTurn = () => resolve(next(e));
			});
		});
		await startSession($);
		for (let i = 0; i < 5; i++) {
			await clock.advance(1);
		}
		const acks = recorded.filter(entry => entry.op === 'ack').map(entry => entry.body);
		finishTurn?.();
		await clock.settle();
		expect({ submitted, acks }).toEqual({
			submitted: ['first'],
			acks: [
				{ sessionId: 'session-1', id: 's1', received: true },
				{ sessionId: 'session-1', id: 's2', ok: false, reason: 'busy' },
				{ sessionId: 'session-1', id: 's3', ok: false, reason: 'busy' },
			],
		});
	});

	test('a prompt handed over for a session that has since changed is refused, not sent', async ($, on) => {
		const recorded: IRecorded[] = [];
		let session = 'session-1';
		let handed = false;
		const clock = fakeParaCode(on, {
			commands: () => {
				if (handed) {
					return { commands: [] };
				}
				handed = true;
				// /clear while the command poll was open: the prompt was asked for the old session
				session = 'session-2';
				return { commands: [{ id: 's9', kind: 'submit', text: 'for the old session' }] };
			},
		}, recorded, true, () => session);
		const submitted: string[] = [];
		on('prompt.submit', ($, e, next) => {
			submitted.push(e.text);
			return next(e);
		});
		await startSession($);
		await clock.advance(1);
		await clock.settle();
		expect({ submitted, acks: recorded.filter(entry => entry.op === 'ack').map(entry => entry.body) }).toEqual({
			submitted: [],
			acks: [{ sessionId: 'session-1', id: 's9', ok: false, reason: 'stale' }],
		});
	});

	test('a TaskStop that is refused acks not ok with the reason', async ($, on) => {
		const recorded: IRecorded[] = [];
		let handed = false;
		const clock = fakeParaCode(on, {
			commands: () => {
				if (handed) {
					return { commands: [] };
				}
				handed = true;
				return { commands: [{ id: 'c3', kind: 'taskStop', taskId: 'b999' }] };
			},
		}, recorded);
		on('tool.call', () => ({ deny: 'No task found with ID: b999' }));
		await startSession($);
		await clock.advance(1);
		await clock.settle();
		expect(recorded.filter(entry => entry.op === 'ack').map(entry => entry.body)).toEqual([{ sessionId: 'session-1', id: 'c3', ok: false, message: 'No task found with ID: b999' }]);
	});

	test('switches to curl only when a fresh fetch fails again while curl gets through', async ($, on) => {
		mock.env(on, { PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: PORT_FILE });
		mock.clock(on);
		on('fs.read', () => ({ value: '{"port":47999}' }));
		on('session.id', () => ({ value: 'session-1' }));
		on('session.start', ($, e) => ({ cwd: e.cwd }));
		on('classic.PermissionRequest', () => ({}));
		let fetches = 0;
		const curls: string[] = [];
		on('http.fetch', () => {
			fetches++;
			return { deny: 'refused by policy' };
		});
		on('process.run', ($, e) => {
			const config = e.init?.stdin ?? '';
			curls.push(/url = "[^"]*\/([a-z]+)"/.exec(config)?.[1] ?? '');
			return { value: { exitCode: 0, stdout: '{"id":"p1","wait":false}\n200', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
		});
		await startSession($);
		await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } });
		const fetchesAfterFirst = fetches;
		await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls -a' } });
		expect({
			retriedFetchFirst: fetchesAfterFirst >= 2,
			noMoreFetches: fetches === fetchesAfterFirst,
			permissionsByCurl: curls.filter(op => op === 'permission').length,
		}).toEqual({ retriedFetchFirst: true, noMoreFetches: true, permissionsByCurl: 2 });
	});

	test('tells Para Code what it can do, and answers a list request with the slash commands in their order', async ($, on) => {
		const recorded: IRecorded[] = [];
		const handed: Json[][] = [[{ id: 'l1', kind: 'commandList' }]];
		const clock = fakeParaCode(on, { commands: () => ({ commands: handed.shift() ?? [] }) }, recorded);
		on('command.list', () => ({
			value: [
				{ name: 'context', description: 'mine', source: 'user' },
				{ name: 'codex:rescue', description: 'Rescue', source: 'plugin', plugin: 'codex' },
				{ name: 'context', description: 'Visualize', source: 'builtin' },
			],
		}));
		await startSession($);
		await clock.advance(1);
		await clock.settle();
		expect({
			features: recorded.find(entry => entry.op === 'commands')?.body.features,
			acks: recorded.filter(entry => entry.op === 'ack').map(entry => entry.body),
		}).toEqual({
			features: ['commands.list', 'command.run', 'prompt.dialog'],
			acks: [{
				sessionId: 'session-1', id: 'l1', ok: true, commands: [
					{ name: 'context', description: 'mine', source: 'user' },
					{ name: 'codex:rescue', description: 'Rescue', source: 'plugin', plugin: 'codex' },
					{ name: 'context', description: 'Visualize', source: 'builtin' },
				],
			}],
		});
	});

	test('runs a slash command from the phone, and acks a refusal with its reason', async ($, on) => {
		const recorded: IRecorded[] = [];
		const handed: Json[][] = [[{ id: 'r1', kind: 'commandRun', command: 'review', args: '123' }], [{ id: 'r2', kind: 'commandRun', command: 'nope', args: '' }]];
		const clock = fakeParaCode(on, { commands: () => ({ commands: handed.shift() ?? [] }) }, recorded);
		const ran: unknown[] = [];
		on('command.run', ($, e) => {
			ran.push({ command: e.command, args: e.args });
			if (e.command === 'nope') {
				throw new Error('no command named /nope in this session');
			}
			return { text: 'reviewed' };
		});
		await startSession($);
		await clock.advance(1);
		await clock.settle();
		await clock.advance(1);
		await clock.settle();
		const acks = recorded.filter(entry => entry.op === 'ack').map(entry => entry.body);
		expect({
			ran,
			ok: acks.find(ack => ack.id === 'r1'),
			refused: { ok: acks.find(ack => ack.id === 'r2')?.ok, reason: acks.find(ack => ack.id === 'r2')?.reason, hasMessage: typeof acks.find(ack => ack.id === 'r2')?.message === 'string' },
		}).toEqual({
			ran: [{ command: 'review', args: '123' }, { command: 'nope', args: '' }],
			ok: { sessionId: 'session-1', id: 'r1', ok: true },
			refused: { ok: false, reason: 'refused', hasMessage: true },
		});
	});

	test('answers whether a screen holds the keys by an empty append to the prompt box', async ($, on) => {
		const recorded: IRecorded[] = [];
		const handed: Json[][] = [[{ id: 'd1', kind: 'dialogCheck' }]];
		const clock = fakeParaCode(on, { commands: () => ({ commands: handed.shift() ?? [] }) }, recorded);
		const fills: unknown[] = [];
		// Under the test host no box is drawn (`no_composer`); a hook cannot claim the `dialog` cause itself, so this
		// checks the call and that anything other than `dialog` is not a screen holding the keys.
		on('prompt.fill', ($, e) => {
			fills.push({ text: e.text, mode: e.mode });
			return { isFilled: true };
		});
		await startSession($);
		await clock.advance(1);
		await clock.settle();
		expect({
			features: recorded.find(entry => entry.op === 'commands')?.body.features,
			fills,
			ack: recorded.find(entry => entry.op === 'ack')?.body,
		}).toEqual({
			features: ['commands.list', 'command.run', 'prompt.dialog'],
			fills: [{ text: '', mode: 'append' }],
			ack: { sessionId: 'session-1', id: 'd1', ok: true, dialog: false },
		});
	});

	test('a new session forgets a send of the old one', async ($, on) => {
		const recorded: IRecorded[] = [];
		let restarted = false;
		const handed: Json[][] = [[{ id: 'p1', kind: 'commandRun', command: 'config', args: '' }], [{ id: 's1', kind: 'submit', text: 'hello' }]];
		const clock = fakeParaCode(on, {
			commands: async () => {
				if (handed.length === 2 || (restarted && handed.length > 0)) {
					return { commands: handed.shift() ?? [] };
				}
				await clock.sleep(500);
				return { commands: [] };
			},
		}, recorded);
		const submitted: string[] = [];
		on('prompt.submit', ($, e, next) => {
			submitted.push(e.text);
			return next(e);
		});
		on('command.run', async ($, e) => {
			if (e.command === 'config') {
				await clock.sleep(60_000);
			}
			return { text: '' };
		});
		await startSession($);
		await clock.advance(1);
		await clock.advance(1_600);
		// /clear or a reload of the mod: session.start comes again while the old panel's run is still pending
		restarted = true;
		await startSession($);
		await clock.advance(600);
		const acks = recorded.filter(entry => entry.op === 'ack').map(entry => entry.body);
		// The prompt is taken (not refused as panel-open or busy): what Claude Code then does with it is its own
		expect({ submitted, s1: acks.find(ack => ack.id === 's1')?.received }).toEqual({ submitted: ['hello'], s1: true });
		await clock.advance(60_000);
	});

	test('refuses an internal command, and marks a refusal for a session that moved on as stale', async ($, on) => {
		const recorded: IRecorded[] = [];
		let session = 'session-1';
		const handed: Json[][] = [[{ id: 'i1', kind: 'commandRun', command: '__remote-workflow', args: '' }], [{ id: 'r1', kind: 'commandRun', command: 'context', args: '' }]];
		const clock = fakeParaCode(on, {
			commands: () => {
				const next = handed.shift() ?? [];
				if (next.some(command => command.id === 'r1')) {
					// /clear while the command poll was open: the command was asked for the old session
					session = 'session-2';
				}
				return { commands: next };
			},
		}, recorded, true, () => session);
		const ran: string[] = [];
		on('command.run', ($, e) => {
			ran.push(e.command);
			return { text: '' };
		});
		await startSession($);
		await clock.advance(1);
		await clock.settle();
		await clock.advance(1);
		await clock.settle();
		const acks = recorded.filter(entry => entry.op === 'ack').map(entry => entry.body);
		expect({ ran, acks: acks.map(ack => [ack.id, ack.ok, ack.reason]) }).toEqual({ ran: [], acks: [['i1', false, 'refused'], ['r1', false, 'stale']] });
	});

	test('sends the context window the status line shows, only when the fill moved', async ($, on) => {
		const recorded: IRecorded[] = [];
		const clock = fakeParaCode(on, {}, recorded);
		on('session.measure', ($, e) => ({ changed: e.changed }));
		await startSession($);
		await $.session.measure({ context: { tokens: 142_800, window: 1_000_000, percent: 14 }, rateLimits: [], changed: ['context'] });
		await $.session.measure({ context: { tokens: 142_800, window: 1_000_000, percent: 14 }, rateLimits: [], changed: ['rateLimits'] });
		await clock.settle();
		const events = recorded.filter(entry => entry.op === 'event').flatMap(entry => entry.body.events as Json[]).filter(event => event.type === 'measure');
		expect(events.map(({ at, ...event }) => event)).toEqual([{ type: 'measure', context: { window: 1_000_000, tokens: 142_800, percent: 14 } }]);
	});

	test('keeps using fetch when it works again after reading the port file once more', async ($, on) => {
		mock.env(on, { PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: PORT_FILE });
		mock.clock(on);
		on('fs.read', () => ({ value: '{"port":47999}' }));
		on('session.id', () => ({ value: 'session-1' }));
		on('session.start', ($, e) => ({ cwd: e.cwd }));
		on('classic.PermissionRequest', () => ({}));
		let failNext = true;
		let curls = 0;
		on('http.fetch', ($, e) => {
			if (e.url.endsWith('/permission') && failNext) {
				failNext = false;
				return { deny: 'connection reset' };
			}
			return { value: { status: 200, ok: true, headers: {}, text: '{"id":"p1","wait":false}' } };
		});
		on('process.run', () => {
			curls++;
			return { value: { exitCode: 7, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
		});
		await startSession($);
		await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } });
		expect(curls).toBe(0);
	});
});
