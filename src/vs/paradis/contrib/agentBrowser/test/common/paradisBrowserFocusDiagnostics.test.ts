/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBrowserDiagnosticsClock, IParadisBrowserDiagnosticsSink, ParadisBrowserDiagnosticData, ParadisBrowserDiagnosticsRecorder, paradisBrowserDiagnosticHost } from '../../common/paradisBrowserFocusDiagnostics.js';
import { paradisParseBrowserDiagnosticNote } from '../../common/paradisBrowserDiagnosticNote.js';

interface IRecorded {
	readonly breadcrumbs: { category: string; message: string; data: ParadisBrowserDiagnosticData }[];
	readonly events: { operation: string; tags: Record<string, string>; data: ParadisBrowserDiagnosticData }[];
}

class FakeClock implements IParadisBrowserDiagnosticsClock {
	time = 1_000_000;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();
	private nextHandle = 1;
	now(): number { return this.time; }
	setTimeout(callback: () => void, ms: number): unknown {
		const handle = this.nextHandle++;
		this.timers.set(handle, { at: this.time + ms, callback });
		return handle;
	}
	clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
	advance(ms: number): void {
		this.time += ms;
		for (const [handle, timer] of [...this.timers]) {
			if (timer.at <= this.time) {
				this.timers.delete(handle);
				timer.callback();
			}
		}
	}
}

function setup(): { recorder: ParadisBrowserDiagnosticsRecorder; clock: FakeClock; recorded: IRecorded } {
	const recorded: IRecorded = { breadcrumbs: [], events: [] };
	const sink: IParadisBrowserDiagnosticsSink = {
		breadcrumb: (category, message, data) => recorded.breadcrumbs.push({ category, message, data }),
		capture: (operation, tags, data) => recorded.events.push({ operation, tags, data }),
	};
	const clock = new FakeClock();
	return { recorder: new ParadisBrowserDiagnosticsRecorder(sink, clock), clock, recorded };
}

/** 利用者がタブを触ってから workbench を押して外へ移す。 */
function leaveByUser(recorder: ParadisBrowserDiagnosticsRecorder, clock: FakeClock, view: object): void {
	recorder.notePointer(undefined);
	clock.advance(20);
	recorder.focusChanged(view, false, 'docs.google.com');
}

suite('paradisBrowserFocusDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('folds URLs to a host name and never keeps a path, query, port or a private name', () => {
		assert.deepStrictEqual([
			'https://docs.google.com/spreadsheets/d/secret-id/edit?usp=sharing#gid=0',
			'http://user:pass@Example.COM:8080/a/b',
			'https://my-branch-user.vercel.app/',
			'https://jira.mycorp.com/browse/X-1',
			'http://localhost:3000/x',
			'http://127.0.0.1/x',
			'http://[::1]/x',
			'http://intranet/x',
			'https://wiki.corp/page',
			'file:///Users/example/private.html',
			'about:blank',
			'vscode-file://vscode-app/x',
			'not a url',
			undefined,
		].map(paradisBrowserDiagnosticHost), [
			'docs.google.com', 'example.com', 'other-public', 'other-public', 'localhost', 'ip-address', 'ip-address', 'single-label', 'private-name',
			'scheme:file', 'scheme:about', 'scheme:other', 'invalid', 'none',
		]);
	});

	test('a return within 3s after the user left is one event per run of returns, with its origin, count and emulation state', () => {
		const { recorder, clock, recorded } = setup();
		const view = {};
		recorder.noteAgentState(view, { connections: 1, focusEmulation: true });
		recorder.notePointer(view);
		recorder.focusChanged(view, true, 'docs.google.com');
		clock.advance(2_000);
		for (let index = 0; index < 3; index++) {
			leaveByUser(recorder, clock, view);
			clock.advance(index === 0 ? 400 : 900);
			recorder.focusChanged(view, true, 'docs.google.com');
			clock.advance(1_000);
		}
		assert.strictEqual(recorded.events.length, 0, 'a run of returns is held until it goes quiet');
		clock.advance(8_000);
		assert.deepStrictEqual(recorded.events, [{
			operation: 'refocus-after-leave',
			tags: { 'para.area': 'browser-focus', 'para.browser_host': 'docs.google.com', 'para.focus_origin': 'page', 'para.focus_emulation': 'true', 'para.agent_cdp': 'true' },
			data: {
				safe_host: 'docs.google.com', safe_returns: 3, safe_origins: 'page=3', safe_first_return_ms: 400, safe_span_ms: 3_840,
				safe_agent_cdp: true, safe_focus_emulation: true, safe_events_this_run: 1,
			},
		}]);
		assert.deepStrictEqual(recorded.breadcrumbs.map(crumb => `${crumb.message}:${crumb.data.safe_origin ?? ''}:${crumb.data.safe_refocus ?? crumb.data.safe_user_left}`), [
			'focus:user-pointer:false', 'blur::true', 'focus:page:true', 'blur::true', 'focus:page:true', 'blur::true',
		], 'thinned to 6 per 10s');
	});

	test('tells Para Code focus, user clicks, agent input and window activation apart, and does not count them as page returns', () => {
		const { recorder, clock, recorded } = setup();
		const view = {};
		const origins: string[] = [];
		const focus = () => {
			recorder.focusChanged(view, true, 'example.com');
			origins.push(String(recorded.breadcrumbs.at(-1)?.data.safe_origin));
			clock.advance(1_000);
		};
		recorder.focusChanged(view, true, 'example.com');
		leaveByUser(recorder, clock, view);
		clock.advance(100);
		recorder.noteFocusRequest(view, 'container-focus');
		focus();
		leaveByUser(recorder, clock, view);
		clock.advance(100);
		recorder.notePointer(view);
		focus();
		leaveByUser(recorder, clock, view);
		clock.advance(100);
		recorder.noteAgentInput(view);
		recorder.notePointer(view); // CDP の入力の写しは利用者のポインタとしない
		focus();
		clock.advance(2_000);
		recorder.focusChanged(view, false, 'example.com'); // 利用者の操作の直後ではない
		clock.advance(10_000);
		recorder.noteAgentState(view, { connections: 1 }); // 普段の focus はパンくずにしないので、ここだけ残させる
		recorder.noteWindowActivation();
		focus();
		clock.advance(20_000);
		assert.deepStrictEqual(origins, ['para-code-container-focus', 'user-pointer', 'agent-input', 'window-activation']);
		// 利用者が自分で戻した 1 回目以外の 2 回（container-focus と agent-input）は戻りとして送る。
		assert.deepStrictEqual(recorded.events.map(event => event.data.safe_origins), ['para-code-container-focus=1', 'agent-input=1']);
	});

	test('a blur not caused by the user and a return after 3s are not anomalies', () => {
		const { recorder, clock, recorded } = setup();
		const view = {};
		recorder.focusChanged(view, true, 'example.com');
		recorder.focusChanged(view, false, 'example.com');
		clock.advance(500);
		recorder.focusChanged(view, true, 'example.com');
		leaveByUser(recorder, clock, view);
		clock.advance(3_500);
		recorder.focusChanged(view, true, 'example.com');
		clock.advance(60_000);
		assert.deepStrictEqual(recorded.events, []);
	});

	test('caps refocus events per run and thins breadcrumbs, counting what it dropped', () => {
		const { recorder, clock, recorded } = setup();
		for (let index = 0; index < 8; index++) {
			const view = {};
			recorder.focusChanged(view, true, 'example.com');
			leaveByUser(recorder, clock, view);
			clock.advance(100);
			recorder.focusChanged(view, true, 'example.com');
			recorder.viewClosed(view);
			clock.advance(10_000);
		}
		assert.strictEqual(recorded.events.length, 5);

		const burst = setup();
		const view = {};
		// 普段の行き来はパンくずにしない。エージェントが繋いでいる間だけ全部残す（間引きつき）。
		for (let index = 0; index < 4; index++) {
			burst.recorder.focusChanged(view, index % 2 === 0, 'example.com');
		}
		assert.strictEqual(burst.recorded.breadcrumbs.length, 0);
		burst.recorder.noteAgentState(view, { connections: 1 });
		for (let index = 0; index < 20; index++) {
			burst.recorder.focusChanged(view, index % 2 === 0, 'example.com');
			burst.clock.advance(100);
		}
		assert.strictEqual(burst.recorded.breadcrumbs.length, 6);
		burst.clock.advance(10_000);
		burst.recorder.focusChanged(view, true, 'example.com');
		assert.strictEqual(burst.recorded.breadcrumbs.at(-1)?.data.safe_dropped_before, 14);
	});

	test('aggregates input failures into one summary event with rates and hosts', () => {
		const { recorder, clock, recorded } = setup();
		for (let index = 0; index < 40; index++) {
			recorder.noteKeyAttempt(index < 30 ? 'docs.google.com' : 'example.com');
		}
		for (let index = 0; index < 12; index++) {
			recorder.noteKeySuppressionFailure('docs.google.com', 'register', 'ack-timeout');
		}
		recorder.noteKeySuppressionFailure('example.com', 'activate', 'user-focus');
		recorder.noteInputQueue('docs.google.com', 'paused', 'dispatch-timeout', 'Input.dispatchMouseEvent');
		recorder.noteInputQueue('docs.google.com', 'resumed', 'dispatch-timeout', 'Input.dispatchMouseEvent');
		recorder.noteToolFailure('docs.google.com', 'click', 'protocol-error', 'key-suppression');
		recorder.noteToolFailure('example.com', 'fill', 'timeout', 'none');
		assert.strictEqual(recorded.events.length, 0);
		clock.advance(30 * 60 * 1_000);
		assert.deepStrictEqual(recorded.events, [{
			operation: 'input-failure-summary',
			tags: { 'para.area': 'browser-input', 'para.browser_host': 'docs.google.com' },
			data: {
				safe_failures: 16,
				safe_kinds: 'key-register:ack-timeout=12,key-activate:user-focus=1,queue-paused:dispatch-timeout=1,tool:click:protocol-error:key-suppression=1,tool:fill:timeout=1',
				safe_hosts: 'docs.google.com=14,example.com=2',
				safe_key_attempts: 40,
				safe_key_failures: 13,
				safe_key_attempts_by_host: 'docs.google.com=30,example.com=10',
				safe_window_ms: 1_800_000,
				safe_summaries_this_run: 1,
			},
		}]);
		// 20 件たまったら時間を待たずに送る。
		for (let index = 0; index < 20; index++) {
			recorder.noteToolFailure('example.com', 'click', 'target-closed', undefined);
		}
		assert.strictEqual(recorded.events.length, 2);
	});

	test('nothing it sends carries a path, query, page text or free-form value', () => {
		const { recorder, clock, recorded } = setup();
		const view = {};
		const host = paradisBrowserDiagnosticHost('https://docs.google.com/spreadsheets/d/1AbCSecretSheet/edit?token=xyz');
		recorder.focusChanged(view, true, host);
		leaveByUser(recorder, clock, view);
		clock.advance(100);
		recorder.focusChanged(view, true, host);
		recorder.noteKeySuppressionFailure(host, 'register', 'reason with spaces /Users/example/file');
		recorder.noteToolFailure(host, 'click /Users/example', 'Error: secret text', 'none');
		recorder.noteInputQueue(host, 'paused', 'see https://example.com/?q=1', 'Input.dispatchKeyEvent');
		recorder.viewClosed(view);
		recorder.flushFailures();
		const sent = JSON.stringify(recorded);
		for (const forbidden of ['/Users', 'spreadsheets', '1AbCSecretSheet', 'token=', 'secret', 'https://', '?q=']) {
			assert.ok(!sent.includes(forbidden), `sent data contains ${forbidden}`);
		}
		for (const entry of [...recorded.breadcrumbs.map(crumb => crumb.data), ...recorded.events.map(event => event.data)]) {
			assert.ok(Object.keys(entry).every(key => key.startsWith('safe_')));
		}
	});

	test('reads IPC notes strictly and drops free-form values', () => {
		assert.deepStrictEqual([
			{ kind: 'agent-state', connections: 2.7 },
			{ kind: 'agent-state', focusEmulation: true },
			{ kind: 'agent-state' },
			{ kind: 'input-queue', queueKind: 'paused', cause: 'dispatch-timeout', method: 'Input.dispatchKeyEvent' },
			{ kind: 'input-queue', queueKind: 'exploded' },
			{ kind: 'tool-failure', tool: 'click', errorKind: 'timeout', gateReason: 'text with spaces' },
			{ kind: 'tool-failure', tool: '/Users/example', errorKind: 'timeout' },
			'tool-failure',
		].map(paradisParseBrowserDiagnosticNote), [
			{ kind: 'agent-state', connections: 2, focusEmulation: undefined },
			{ kind: 'agent-state', connections: undefined, focusEmulation: true },
			undefined,
			{ kind: 'input-queue', queueKind: 'paused', cause: 'dispatch-timeout', method: 'Input.dispatchKeyEvent' },
			undefined,
			{ kind: 'tool-failure', tool: 'click', errorKind: 'timeout', gateReason: undefined },
			undefined,
			undefined,
		]);
	});
});
