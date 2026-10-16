// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ITaskBoardArtifact, ITaskBoardHistoryEntry, ITaskBoardPrRef, ITaskBoardSlot, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import type { ITaskBoardPersisted } from '@engine/paradisTaskBoardEngine.js';
import { mockHtml, screenshotSvg } from './sim.js';

/*
 * GitHub につながないとき（--demo）に入れる見本の台帳。
 * 架空のリポジトリ example/para-code の Issue で、工程のあちこちにタスクを置く。
 */

const OWNER = 'example';
const REPO = 'para-code';

export function demoSlots(): ITaskBoardSlot[] {
	return [1, 2, 3, 4].map(n => ({ id: `sim:para-code-${n}`, name: `para-code-${n}`, path: `~/projects/para-code-${n}`, kind: 'clone-pool' as const }));
}

function day(offset: number): string {
	const d = new Date();
	d.setDate(d.getDate() + offset);
	return d.toISOString().slice(0, 10);
}

export function buildDemo(flowId: string): { state: ITaskBoardPersisted; resume: string[] } {
	const now = Date.now();
	const min = 60000;
	let seq = 0;
	const id = () => `demo${++seq}`;
	const issue = (n: number) => ({ owner: OWNER, repo: REPO, number: n, url: '' });
	const base = (n: number, title: string, extra: Partial<ITaskBoardTask>): ITaskBoardTask => ({
		id: `gh:${OWNER}/${REPO}#${n}`, title, source: 'github', issue: issue(n), labels: [], assignees: ['you'], flowId,
		step: 'todo', status: 'todo', stepSince: now, createdAt: now - 3 * 24 * 60 * min, updatedAt: now,
		activities: [], history: [], artifacts: [], log: [], ...extra, attempt: 1,
	});
	const done = (stepId: string, startMin: number, endMin: number, agent?: 'claude' | 'codex'): ITaskBoardHistoryEntry => ({ stepId, startedAt: now - startMin * min, endedAt: now - endMin * min, result: 'done', agent });
	const label = (name: string, color: string) => ({ name, color });
	const plan = (n: number, lines: string[]): ITaskBoardArtifact => ({
		id: id(), kind: 'plan', title: '計画', stepId: 'plan', createdAt: now - 30 * min, path: `docs/plan-${n}.md`,
		content: ['## 目的', '', lines[0], '', '## 手順', '', ...lines.slice(1).map(l => `- [ ] ${l}`), '', '## 確かめ方', '', '関係する単体テストを回し、変更した画面のスクショを PR に添付する。'].join('\n'),
	});
	const pr = (n: number, extra: Partial<ITaskBoardPrRef>): ITaskBoardPrRef => ({ owner: OWNER, repo: REPO, number: n, url: '', state: 'draft', checks: 'pending', review: 'none', simulated: true, ...extra });

	const mockA = { id: id(), kind: 'mock' as const, title: '案 A タブごと', stepId: 'plan', createdAt: now - 5 * min, path: 'mocks/412-a.html', content: mockHtml('案 A', 'a') };
	const mockB = { id: id(), kind: 'mock' as const, title: '案 B まとめる', stepId: 'plan', createdAt: now - 5 * min, path: 'mocks/412-b.html', content: mockHtml('案 B', 'b') };

	const tasks: ITaskBoardTask[] = [
		base(418, '設定の検索で同義語にも当たるようにする', { labels: [label('設定', '1d76db'), label('UI/UX', 'a371f7')], due: day(2), priority: '高', projectStatus: 'Todo', body: '設定画面の検索で「透明」と入れても「不透明度」の項目が出てこない。よく使う言い換えにも当たるようにしたい。\n\n### やること\n\n- [ ] 言い換えの辞書を足す\n- [ ] 検索結果に「言い換えで一致」と出す\n\n### 対象外\n\nVS Code 本体の設定エディタは触らない。' }),
		base(420, '通知の既読をモバイルと同期する', { labels: [label('通知', 'fbca04'), label('モバイル', '0e8a16')], due: day(3), priority: '中', projectStatus: 'Todo', body: 'PC で既読にした通知が、モバイルでは未読のまま残る。どちらかで読んだら両方で既読にしたい。' }),
		base(421, 'ポート一覧を使用中の順に並べる', { labels: [label('ターミナル', '5319e7')], due: day(6), projectStatus: 'Todo', body: 'ポート一覧が番号順なので、今使っているものが下に埋もれる。最後に通信があった順に並べたい。' }),
		base(423, 'ズーム率をスペースごとに覚える', { labels: [label('エディタ', 'c5def5')], projectStatus: 'Todo', body: 'スペースを切り替えるとズーム率が全体で共通になってしまう。スペースごとに覚えてほしい。' }),
		base(425, '拡張機能の更新通知を 1 つにまとめる', { labels: [label('通知', 'fbca04')], due: day(9), projectStatus: 'Todo', body: '拡張機能の更新が複数あると通知が個別に出る。1 つにまとめたい。' }),
		base(412, 'ターミナル検索の結果をタブごとに見られるようにする', {
			labels: [label('ターミナル', '5319e7'), label('UI/UX', 'a371f7')], due: day(1), priority: '高', projectStatus: 'In Progress',
			body: 'ターミナルの検索が今のタブの中しか探さない。開いている全部のターミナルから探して、結果を見られるようにしたい。\n\n### 受け入れ条件\n\n- [ ] 全ターミナルを対象に検索できる\n- [ ] 結果からそのターミナルの該当行へ移れる\n\n```\nCmd+Shift+F（ターミナルにフォーカスがあるとき）\n```',
			step: 'plan', status: 'question', stepSince: now - 4 * min, agent: 'claude', model: 'opus', place: 'sim:para-code-2', branch: 'para/412-terminal-search', contextPct: 38,
			artifacts: [mockA, mockB],
			question: { id: id(), kind: 'question', text: '検索結果をターミナルのタブごとに分けますか、1 つにまとめますか', allowText: true, askedAt: now - 4 * min, options: [{ label: 'タブごとに分ける', detail: '既存の検索ビューと揃う。モック案 A', artifactId: mockA.id }, { label: '1 つにまとめ、行の頭にタブ名を出す', detail: '全部を一度に見られる。モック案 B', artifactId: mockB.id }] },
			activities: [
				{ at: now - 9 * min, kind: 'tool', label: 'Read', detail: 'src/vs/workbench/contrib/terminal/browser/terminalFind.ts' },
				{ at: now - 8 * min, kind: 'tool', label: 'Grep', detail: 'findNext.*xterm' },
				{ at: now - 6 * min, kind: 'tool', label: 'Write', detail: 'mocks/412-a.html' },
				{ at: now - 5 * min, kind: 'tool', label: 'Write', detail: 'mocks/412-b.html' },
			],
			log: ['~/projects/para-code-2 $ claude', '› #412「ターミナル検索の結果をタブごとに見られるようにする」を調査して計画を書いて', '● Issue #412 を読みました。ターミナル検索の実装を調べます', '  ⎿ Read terminalFind.ts (218 行)', '  ⎿ Grep "findNext.*xterm" 6 件', '● モックを 2 案作りました', '? 検索結果をターミナルのタブごとに分けますか、1 つにまとめますか'],
		}),
		base(415, '計測キーの名前を除外規則に当たらないものに変える', {
			labels: [label('計測', 'd4c5f9')], due: day(1), priority: '中', projectStatus: 'In Progress',
			body: '一部の計測値が送信先で空になって届く。キー名が既定の除外規則に部分一致しているのが原因。',
			step: 'approve', status: 'approval', stepSince: now - 9 * min, agent: 'claude', model: 'opus', branch: 'para/415-metric-names',
			history: [done('plan', 18, 9, 'claude')],
			artifacts: [plan(415, ['一部の計測値が送信先で空になって届く。キー名が既定の除外規則に部分一致しているのが原因。', '計測キー 3 つの名前を、除外規則に当たらない名前へ変える', '名前が除外規則に当たらないことを確かめるテストを足す', '更新履歴の未リリースに 1 行足す'])],
			log: ['● 計画を docs/plan-415.md に書きました', '  ⎿ board_complete_step: plan → approve（人の承認待ち）'],
		}),
		base(409, 'ポート一覧の更新間隔を設定で変えられるようにする', {
			labels: [label('ターミナル', '5319e7'), label('設定', '1d76db')], due: day(4), projectStatus: 'In Progress',
			step: 'build', status: 'working', stepSince: now - 18 * min, agent: 'codex', model: 'gpt-6.1-sol', place: 'sim:para-code-1', branch: 'para/409-port-interval', contextPct: 54,
			history: [done('plan', 50, 38, 'codex'), done('approve', 38, 36)],
			artifacts: [plan(409, ['ポート一覧の更新が 5 秒固定で、重い環境では負荷になる。', '設定 paradis.portList.interval を足す', '一覧の更新をこの設定に従わせる', '設定ダイアログにも載せる'])],
			log: ['● 計画どおりに実装します', '  ⎿ 4 ファイルを変更'],
		}),
		base(407, '差分ビューで折りたたんだ箇所を保つ', {
			labels: [label('エディタ', 'c5def5')], due: day(5), projectStatus: 'In Progress',
			step: 'review', status: 'working', stepSince: now - 6 * min, agent: 'codex', model: 'gpt-6.1-sol', place: 'sim:para-code-3', branch: 'para/407-diff-fold', contextPct: 21,
			history: [done('plan', 95, 80, 'claude'), done('approve', 80, 76), done('build', 76, 6, 'claude')],
		}),
		base(401, '通知音を選べるようにする', {
			labels: [label('通知', 'fbca04')], due: day(2), projectStatus: 'In Review',
			step: 'bot', status: 'waiting', stepSince: now - 3 * min, agent: 'claude', branch: 'para/401-notify-sound', prOwned: true, pr: pr(371, { title: '通知音を選べるようにする' }),
			history: [done('plan', 170, 162, 'claude'), done('approve', 162, 161), done('build', 161, 123, 'claude'), done('review', 123, 112, 'codex'), done('pr', 112, 111)],
		}),
		base(398, '履歴の重複を除く', {
			labels: [label('ターミナル', '5319e7')], due: day(0), priority: '高', projectStatus: 'In Review',
			step: 'e2e', status: 'failed', stepSince: now - min, agent: 'claude', branch: 'para/398-history-dedupe', error: 'history.dedupe / history.restore が失敗',
			prOwned: true, pr: pr(368, { title: '履歴の重複を除く', checks: 'failure', checksPassed: 3, checksTotal: 4, review: 'commented' }),
			history: [done('plan', 240, 230, 'claude'), done('approve', 230, 229), done('build', 229, 183, 'claude'), done('review', 183, 170, 'codex'), done('pr', 170, 169), done('bot', 169, 164)],
			log: ['$ scripts/test-integration.sh --grep history', '  ✓ history.load (812ms)', '  ✗ history.dedupe（期待 3 行、実際 4 行）', '  ✗ history.restore（Timeout of 20000ms exceeded）', '', '  1 passing, 2 failing'],
		}),
		base(395, 'ズーム表示の位置がずれるのを直す', {
			labels: [label('エディタ', 'c5def5'), label('UI/UX', 'a371f7')], due: day(3), projectStatus: 'In Review',
			step: 'merge', status: 'ready', stepSince: now - 22 * min, agent: 'claude', branch: 'para/395-zoom-position',
			prOwned: true, pr: pr(366, { title: 'ズーム表示の位置がずれるのを直す', state: 'open', checks: 'success', checksPassed: 4, checksTotal: 4, review: 'approved' }),
			artifacts: [0, 1, 2].map(i => ({ id: id(), kind: 'screenshot' as const, title: `screenshot-${i + 1}.png`, stepId: 'shots', createdAt: now - 231 * min, path: `.para-code/shots/395-${i + 1}.png`, content: screenshotSvg(i, 'ズーム表示の位置') })),
			history: [done('plan', 300, 293, 'claude'), done('approve', 293, 292), done('build', 292, 263, 'claude'), done('review', 263, 252, 'codex'), done('pr', 252, 251), done('bot', 251, 245), done('e2e', 245, 235), done('shots', 235, 231, 'claude')],
		}),
	];
	return { state: { version: 1, activeFlowId: flowId, tasks }, resume: [`gh:${OWNER}/${REPO}#409`, `gh:${OWNER}/${REPO}#407`] };
}
