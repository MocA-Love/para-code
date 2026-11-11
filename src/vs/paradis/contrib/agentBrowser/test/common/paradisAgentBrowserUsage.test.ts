/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisSentryScrubbedWord, ParadisSpanAttributes } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisFakeUsageClock } from '../../../sentry/test/common/paradisFakeUsageClock.js';
import { IParadisAgentBrowserUsageSettings, IParadisRunStepsStats, PARADIS_AGENT_BROWSER_USAGE_INTERVAL_MS, PARADIS_SNAPSHOT_REFETCH_WINDOW_MS, ParadisAgentBrowserUsage, ParadisSiteNoteOutcome, ParadisSiteRecipeOutcome, ParadisSnapshotDiffOutcome, paradisRunStepsFeatures } from '../../common/paradisAgentBrowserUsage.js';

suite('Para Browser experimental feature usage (Sentry)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const allOff: IParadisAgentBrowserUsageSettings = { settle: false, state: false, snapshotDiff: false, siteNotes: false, siteRecipes: false, runStepsFlow: false };

	function create(settings: () => IParadisAgentBrowserUsageSettings = () => allOff) {
		const sent: { readonly name: string; readonly attributes: ParadisSpanAttributes }[] = [];
		const clock = new ParadisFakeUsageClock();
		const usage = new ParadisAgentBrowserUsage(settings, (feature, operation, attributes) => sent.push({ name: `para.${feature}.${operation}`, attributes }), clock);
		return { sent, clock, usage };
	}

	const noRun: IParadisRunStepsStats = { refused: false, executed: 0, failed: 0, expectFailed: 0, stop: 'none' };

	test('どの回数の名前も、Sentry が消す語を含まず送れる形になっている（全部を 1 回ずつ数えて確かめる）', () => {
		const { sent, usage } = create(() => ({ settle: true, state: true, snapshotDiff: true, siteNotes: true, siteRecipes: true, runStepsFlow: true }));
		usage.noteCall(true);
		for (const tool of ['write_site_note', 'save_recipe', 'run_steps', 'click']) {
			usage.noteArgumentRefusal(tool, { note: 'x' });
		}
		for (const observe of ['changes', 'none', 'snapshot'] as const) {
			usage.noteObserved(observe, 0, true);
		}
		for (const outcome of ['quiet', 'timeout', 'unresponsive', 'dialog'] as const) {
			for (const waited of [100, 1_000, 3_000]) {
				usage.noteSettle(outcome, waited);
			}
		}
		const features = { forEach: true, repeatUntil: true, expect: true, sleep: true, reference: true };
		for (const stop of ['none', 'failure', 'step_limit', 'time_limit', 'cancelled'] as const) {
			usage.noteRunSteps(true, features, { ...noRun, stop, failed: stop === 'none' ? 1 : 0, expectFailed: 1 });
		}
		usage.noteRunSteps(false, features, { ...noRun, refused: true });
		usage.noteRunSteps(false, features, noRun);
		usage.noteStepRefusal({ observe: 'none' });
		usage.noteSnapshotCall();
		const snapshotOutcomes: ParadisSnapshotDiffOutcome[] = ['diff', 'full_requested', 'full_no_baseline', 'full_truncated', 'full_child_changed', 'full_too_large'];
		snapshotOutcomes.forEach(outcome => usage.noteSnapshotOutcome('tab', outcome));
		const noteOutcomes: ParadisSiteNoteOutcome[] = ['ok', 'no_text', 'card_number', 'private_text', 'store_full', 'site_not_open', 'no_site', 'no_space', 'no_tabs', 'unverified', 'missing', 'error'];
		for (const tool of ['write', 'list', 'delete'] as const) {
			noteOutcomes.forEach(outcome => usage.noteSiteNote(tool, outcome, 700));
		}
		usage.noteSiteNote('write', 'ok', 100);
		usage.noteSiteNote('write', 'ok', 300);
		usage.noteSiteNote('write', 'ok', 500);
		usage.noteSiteHint('notes', 6_000);
		usage.noteSiteHint('notes', 1_000);
		usage.noteSiteHint('notes', 3_000);
		usage.noteSiteHint('recipes', 100);
		const recipeOutcomes: ParadisSiteRecipeOutcome[] = ['ok', 'failed', 'invalid', 'store_full', 'missing', 'site_not_open', 'no_site', 'no_space', 'no_tabs', 'unverified', 'error'];
		for (const tool of ['save', 'run', 'list', 'delete'] as const) {
			recipeOutcomes.forEach(outcome => usage.noteSiteRecipe(tool, outcome));
		}
		for (const runner of ['same_pane', 'other_pane', 'unknown'] as const) {
			usage.noteSiteRecipe('run', 'ok', runner);
			usage.noteSiteRecipe('run', 'failed', runner);
		}
		usage.noteBrowserState({ tabs: true, newPage: false, download: false, dialog: false, chars: 400 }, false);
		usage.noteBrowserState({ tabs: true, newPage: true, download: true, dialog: true, chars: 1_000 }, true);
		usage.noteBrowserState({ tabs: false, newPage: false, download: true, dialog: false, chars: 2_000 }, false);
		usage.noteBrowserStateUnchanged();
		usage.dispose();
		const keys = Object.keys(sent[0].attributes);
		const values = Object.values(sent[0].attributes).filter((value): value is string => typeof value === 'string');
		assert.deepStrictEqual({
			count: sent.length,
			name: sent[0].name,
			scrubbedKeys: keys.filter(isParadisSentryScrubbedWord),
			scrubbedValues: values.filter(isParadisSentryScrubbedWord),
			dropped: sent[0].attributes.safe_dropped_names,
			settings: keys.filter(key => key.startsWith('safe_set_')),
		}, {
			count: 1,
			name: 'para.agentBrowser.usage',
			scrubbedKeys: [],
			scrubbedValues: [],
			dropped: undefined,
			settings: ['safe_set_settle', 'safe_set_state', 'safe_set_snapshot_diff', 'safe_set_site_notes', 'safe_set_site_recipes', 'safe_set_steps_flow'],
		});
	});

	test('操作の後の待ち・run_steps・サイトメモ・状態の添え書きを、決まった名前の回数にする', () => {
		const { sent, usage } = create(() => ({ ...allOff, settle: true, siteNotes: true }));
		usage.noteCall(false);
		usage.noteCall(true);
		usage.noteObserved('none', 2_000, true);
		usage.noteObserved('changes', 0, true);
		usage.noteSettle('quiet', 240);
		usage.noteSettle('timeout', 2_010);
		usage.noteArgumentRefusal('write_site_note', { note: 'try the second button' });
		usage.noteSiteNote('write', 'ok', 296);
		usage.noteRunSteps(true, paradisRunStepsFeatures({ steps: [{ tool: 'click_by', args: { text: '$item' } }] }), { refused: false, executed: 3, failed: 1, expectFailed: 0, stop: 'failure' });
		usage.noteStepRefusal({ selector: '#a', observe: 'none' });
		usage.noteBrowserState({ tabs: true, newPage: false, download: false, dialog: false, chars: 456 }, false);
		usage.dispose();
		assert.deepStrictEqual(sent[0].attributes, {
			safe_set_settle: 'on', safe_set_state: 'off', safe_set_snapshot_diff: 'off', safe_set_site_notes: 'on', safe_set_site_recipes: 'off', safe_set_steps_flow: 'off',
			safe_calls: 2, safe_call_failures: 1,
			safe_observe_calls: 2, safe_observe_none: 1, safe_settle_zero: 1,
			safe_settle_quiet: 1, safe_settle_quiet_ms: 240, safe_settle_timeout: 1, safe_settle_timeout_ms: 2_010, safe_settle_wait_ms: 2_250, safe_settle_wait_le_500: 1, safe_settle_wait_gt_2000: 1,
			safe_arg_refused: 1, safe_note_arg_refused: 1, safe_note_arg_note: 1,
			safe_note_write_ok: 1, safe_note_len_le_400: 1,
			safe_steps_calls: 1, safe_steps_flow_calls: 1, safe_steps_used_reference: 1, safe_steps_executed: 3, safe_steps_stop_failure: 1,
			safe_steps_step_refused: 1, safe_steps_step_observe_refused: 1,
			safe_state_added: 1, safe_state_tabs_only: 1, safe_state_chars: 456, safe_state_len_le_500: 1,
			safe_window_ms: 0,
		});
	});

	test('差分を返した後に同じタブで full を取り直したら、期限の中だけ「取り直し」に数える', () => {
		const { sent, clock, usage } = create(() => ({ ...allOff, snapshotDiff: true }));
		usage.noteSnapshotOutcome('tab-a', 'diff');
		clock.advance(10_000);
		usage.noteSnapshotOutcome('tab-a', 'full_requested');
		usage.noteSnapshotOutcome('tab-b', 'diff');
		clock.advance(PARADIS_SNAPSHOT_REFETCH_WINDOW_MS + 1);
		usage.noteSnapshotOutcome('tab-b', 'full_requested');
		usage.noteSnapshotOutcome('tab-c', 'full_requested');
		usage.dispose();
		assert.deepStrictEqual([sent[0].attributes.safe_snap_diff, sent[0].attributes.safe_snap_full_requested, sent[0].attributes.safe_snap_refetch_after_diff], [2, 3, 1]);
	});

	test('30 分ごとに送り、オフの人の呼び出しも数える', () => {
		const { sent, clock, usage } = create();
		usage.noteCall(false);
		clock.advance(PARADIS_AGENT_BROWSER_USAGE_INTERVAL_MS);
		usage.noteSnapshotCall();
		usage.dispose();
		assert.deepStrictEqual(sent.map(entry => [entry.attributes.safe_set_settle, entry.attributes.safe_calls, entry.attributes.safe_snap_calls, entry.attributes.safe_window_ms]), [['off', 1, undefined, PARADIS_AGENT_BROWSER_USAGE_INTERVAL_MS], ['off', undefined, 1, 0]]);
	});

	test('run_steps の引数から、使われた書き方だけを拾う', () => {
		assert.deepStrictEqual([
			paradisRunStepsFeatures({ steps: [{ tool: 'click', args: { uid: '1' } }] }),
			paradisRunStepsFeatures({ steps: [{ for_each: '$2.items', steps: [{ expect: { text: 'Done' } }, { sleep_seconds: 1 }] }, { repeat_until: { text: 'End' }, steps: [] }] }),
			paradisRunStepsFeatures(undefined),
		], [
			{ forEach: false, repeatUntil: false, expect: false, sleep: false, reference: false },
			{ forEach: true, repeatUntil: true, expect: true, sleep: true, reference: true },
			{ forEach: false, repeatUntil: false, expect: false, sleep: false, reference: false },
		]);
	});
});
