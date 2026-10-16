// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ITaskBoardArtifact, ITaskBoardComment, ITaskBoardFlow, ITaskBoardIssueDetail, ITaskBoardPullDetail, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { useTaskActions } from '../actions.js';
import { artifactUrl, cachedRpc, fetchText } from '../api.js';
import { useApp } from '../context.js';
import { ago, completionRule, duration, errorText, KIND, stepName, taskActivity, timeOfDay } from '../format.js';
import { useAsync, useNow, useStored } from '../hooks.js';
import { Icon } from '../icons.js';
import { GitHubHtml } from '../githubHtml.js';
import { Markdown } from '../markdown.js';
import { AgentTag, Avatar, CiIcon, Elapsed, LabelChip, Skeleton, Spinner, StepAgent, tone } from './atoms.js';
import { Composer } from './Composer.js';
import { ImageDialog } from './dialogs.js';

function LoadError({ error, retry }: { error: Error; retry: () => void }) {
	return <div className="note-inline"><Icon name="warning" />読み込めませんでした（{error.message}）<span className="grow" /><button className="btn xs" onClick={retry}>もう一度</button></div>;
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
	return <div className="empty"><b>{title}</b>{children}</div>;
}

/* ======================================================================
   Issue
   ====================================================================== */

export function IssueTab({ task, flow, repoUrl }: { task: ITaskBoardTask; flow: ITaskBoardFlow; repoUrl?: string }) {
	const app = useApp();
	const actions = useTaskActions();
	const now = useNow();
	const detail = useAsync<ITaskBoardIssueDetail | undefined>(force => cachedRpc('issueDetail', { taskId: task.id }, 20000, force), [task.id]);
	const [posted, setPosted] = useState<ITaskBoardComment[]>([]);
	const d = detail.data;
	const started = task.activities.find(a => a.kind === 'system' && a.label === 'started');
	// 投稿した直後は、読み直しが届くまで手元のコメントを末尾に出しておく
	const comments = [...(d?.comments ?? []), ...posted.filter(p => !d?.comments.some(c => c.id && c.id === p.id))];
	const body = d?.bodyHTML ? <GitHubHtml html={d.bodyHTML} /> : <Markdown source={d?.body ?? task.body ?? ''} repoUrl={repoUrl} />;
	return (
		<>
			{task.source !== 'github' && <div className="note-inline"><Icon name="info" />{task.source === 'adopted' ? '手で起動したエージェントから取り込んだタスクです（Issue はありません）。' : 'ボードだけのタスクです（GitHub の Issue はありません）。コメントはボードの中にだけ残ります。'}</div>}
			{d?.simulated && task.source === 'github' && <div className="note-inline"><Icon name="info" />見本のデータです（GitHub から読んでいません）。</div>}
			{detail.error && <LoadError error={detail.error} retry={detail.reload} />}
			<div className="cmt">
				<Avatar name={d?.author ?? 'you'} src={d?.authorAvatar} large />
				<div className="box">
					<div className="box-h"><span className="who">{d?.author ?? (task.source === 'github' ? '…' : 'あなた')}</span>が作成　<span className="faint">{d ? ago(d.createdAt, now) : ago(task.createdAt, now)}</span><span className="grow" />{detail.loading && <Spinner small />}<button className="btn xs ghost" onClick={detail.reload} title="読み直す" aria-label="読み直す"><Icon name="sync" size={12} /></button>{d?.url && <a href={d.url} target="_blank" rel="noreferrer" className="btn xs ghost"><Icon name="ext" size={12} />GitHub</a>}</div>
					<div className="box-b">{detail.loading && !d && task.source === 'github' ? <Skeleton lines={4} /> : body}</div>
				</div>
			</div>
			{(d?.events.length || started || task.pr) && (
				<div className="timeline">
					{d?.events.map((e, i) => (
						<div className="ev" key={i}>
							<span className={`evi ${e.kind === 'referenced' ? 'green' : e.kind === 'closed' ? 'purple' : ''}`}><Icon name={e.kind === 'labeled' || e.kind === 'unlabeled' ? 'label' : e.kind === 'assigned' ? 'person' : e.kind === 'referenced' ? 'pr' : e.kind === 'closed' ? 'issueClosed' : 'issue'} size={13} /></span>
							<Avatar name={e.actor} src={e.actorAvatar} />
							<b>{e.actor}</b>
							{e.kind === 'labeled' && <>がラベル {e.label && <LabelChip label={e.label} />} を付けました</>}
							{e.kind === 'unlabeled' && <>がラベル {e.label && <LabelChip label={e.label} />} を外しました</>}
							{e.kind === 'assigned' && <>が <b>{e.assignee}</b> に割り当てました</>}
							{e.kind === 'referenced' && e.pr && <>が PR <a href={e.pr.url} target="_blank" rel="noreferrer">#{e.pr.number} {e.pr.title}</a> から参照しました</>}
							{e.kind === 'closed' && <>が閉じました</>}
							{e.kind === 'reopened' && <>が開き直しました</>}
							{e.kind === 'renamed' && <>がタイトルを変えました</>}
							<span className="when">{ago(e.at, now)}</span>
						</div>
					))}
					{started && <div className="ev"><span className="evi accent"><Icon name="play" size={13} /></span><b>タスクボード</b>が{task.agent && <AgentTag agent={task.agent} />}で着手しました{task.branch && <span className="branch">{task.branch}</span>}<span className="when">{ago(started.at, now)}</span></div>}
					{task.pr && <div className="ev"><span className="evi green"><Icon name="pr" size={13} /></span>PR <a onClick={() => app.setTab('pr')} style={{ cursor: 'pointer' }}>#{task.pr.number}</a> がこのタスクに結び付いています{task.pr.simulated && <span className="chip sim">見本</span>}</div>}
				</div>
			)}
			{comments.map((c, i) => <CommentCard key={c.id ?? i} comment={c} repoUrl={repoUrl} />)}
			{d?.locked ? (
				<div className="note-inline" style={{ marginTop: 14 }}><Icon name="info" />この Issue はロックされていて、コメントできません。</div>
			) : (
				<div style={{ marginTop: 14 }}>
					<Composer task={task} target="issue" me={app.snapshot.github.login} meAvatar={app.snapshot.github.avatarUrl} repoUrl={repoUrl} onPosted={c => { setPosted(list => [...list, c]); detail.reload(); }} />
				</div>
			)}
			{task.step === 'todo' && (
				<div className="sticky-act">
					<button className="btn primary" onClick={() => actions.start(task)}><Icon name="play" />着手する</button>
					<span className="muted">「{flow.steps[0].name}」から始めます</span>
				</div>
			)}
		</>
	);
}

function CommentCard({ comment, repoUrl }: { comment: ITaskBoardComment; repoUrl?: string }) {
	const now = useNow();
	return (
		<div className="cmt">
			<Avatar name={comment.author} src={comment.authorAvatar} large kind={!comment.authorAvatar && comment.isBot ? 'bot' : undefined} />
			<div className="box">
				<div className="box-h"><span className="who">{comment.author}</span>{comment.isBot && <span className="chip">bot</span>}<span className="faint">{ago(comment.createdAt, now)}</span></div>
				<div className="box-b">{comment.bodyHTML ? <GitHubHtml html={comment.bodyHTML} /> : <Markdown source={comment.body} repoUrl={repoUrl} />}</div>
			</div>
		</div>
	);
}

/* ======================================================================
   PR
   ====================================================================== */

interface IDiffRow { readonly type: 'hunk' | 'add' | 'del' | 'ctx'; readonly oldLine?: number; readonly newLine?: number; readonly text: string }

export function parsePatch(patch: string): IDiffRow[] {
	const rows: IDiffRow[] = [];
	let o = 0;
	let n = 0;
	for (const line of patch.split('\n')) {
		const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (h) {
			o = Number(h[1]);
			n = Number(h[2]);
			rows.push({ type: 'hunk', text: line });
		} else if (line.startsWith('+')) {
			rows.push({ type: 'add', newLine: n++, text: line.slice(1) });
		} else if (line.startsWith('-')) {
			rows.push({ type: 'del', oldLine: o++, text: line.slice(1) });
		} else if (line.startsWith('\\')) {
			continue;
		} else {
			rows.push({ type: 'ctx', oldLine: o++, newLine: n++, text: line.slice(1) });
		}
	}
	return rows;
}

function Diff({ patch, maxRows }: { patch: string; maxRows?: number }) {
	const rows = parsePatch(patch);
	const shown = maxRows ? rows.slice(-maxRows) : rows;
	return (
		<div className="diff-scroll">
			<table>
				<tbody>
					{shown.map((r, i) => (
						<tr key={i} className={r.type === 'ctx' ? '' : r.type}>
							{r.type === 'hunk' ? <td colSpan={3} className="code">{r.text}</td> : <>
								<td className="ln">{r.oldLine ?? ''}</td>
								<td className="ln">{r.newLine ?? ''}</td>
								<td className="code">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}{r.text}</td>
							</>}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function DiffStat({ add, del }: { add: number; del: number }) {
	const total = add + del || 1;
	const a = Math.round((add / total) * 5);
	return <span className="diffstat" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <i key={i} className={i < a ? 'a' : i < 5 && del ? 'd' : ''} />)}</span>;
}

function FilePatch({ task, path }: { task: ITaskBoardTask; path: string }) {
	const patch = useAsync(force => cachedRpc('pullFilePatch', { taskId: task.id, path }, 60000, force), [task.id, path]);
	if (patch.loading && !patch.data) {
		return <div className="box-b"><Skeleton lines={6} /></div>;
	}
	if (patch.error) {
		return <div className="box-b"><LoadError error={patch.error} retry={patch.reload} /></div>;
	}
	if (!patch.data?.patch) {
		return <div className="box-b faint">差分を表示できません（大きすぎるか、バイナリのファイルです）。</div>;
	}
	return <Diff patch={patch.data.patch} />;
}

export function PrTab({ task }: { task: ITaskBoardTask }) {
	const app = useApp();
	const actions = useTaskActions();
	const now = useNow();
	const [sub, setSub] = useStored<'conv' | 'checks' | 'files' | 'commits'>('prTab', 'conv');
	const [file, setFile] = useState<string>();
	const [posted, setPosted] = useState<ITaskBoardComment[]>([]);
	const detail = useAsync<ITaskBoardPullDetail | undefined>(force => cachedRpc('pullDetail', { taskId: task.id }, 15000, force), [task.id, task.pr?.checks, task.pr?.review, task.pr?.state]);
	const d = detail.data;
	const pr = task.pr!;
	const repoUrl = `https://github.com/${pr.owner}/${pr.repo}`;
	useEffect(() => {
		if (task.status === 'failed' && pr.checks === 'failure') {
			setSub('checks');
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [task.id]);
	if (detail.loading && !d) {
		return <><Skeleton lines={2} /><Skeleton lines={5} /></>;
	}
	if (detail.error && !d) {
		return <LoadError error={detail.error} retry={detail.reload} />;
	}
	if (!d) {
		return <Empty title="PR の詳細を読めませんでした">GitHub につながっていないか、権限がありません。</Empty>;
	}
	const passed = d.checks.filter(c => c.state === 'success' || c.state === 'skipped' || c.state === 'neutral').length;
	const failing = d.checks.filter(c => c.state === 'failure' || c.state === 'cancelled');
	const pending = d.checks.filter(c => c.state === 'pending' || c.state === 'queued');
	const selected = file ?? d.files[0]?.path;
	const reviewed = d.reviews.length > 0;
	const changes = d.reviewDecision === 'changes' || d.reviews.some(r => r.state === 'changes');
	const approved = d.reviewDecision === 'approved' || d.reviews.some(r => r.state === 'approved');
	const merge = (
		<div className="merge">
			<div className="merge-row">
				<span className={`merge-ic ${approved ? 'ok' : changes ? 'ng' : reviewed ? 'ok' : 'wait'}`}><Icon name="eye" /></span>
				<div><div className="t">{approved ? '承認されています' : changes ? '変更を求められています' : reviewed ? `レビューが ${d.reviews.length} 件付いています` : 'レビューを待っています'}</div><div className="d">{d.reviews.length ? [...new Set(d.reviews.map(r => r.author))].join('、') : 'レビュアーなし'}</div></div>
				<span />
			</div>
			<div className="merge-row">
				<span className={`merge-ic ${failing.length ? 'ng' : pending.length ? 'wait' : 'ok'}`}><Icon name={failing.length ? 'x' : 'check'} /></span>
				<div><div className="t">{!d.checks.length ? 'チェックはありません' : failing.length ? `${failing.length} 件のチェックが失敗しています` : pending.length ? `チェックを実行しています（${passed}/${d.checks.length}）` : 'すべてのチェックが通りました'}</div><div className="d">{failing.map(c => c.name).join('、') || `${d.checks.length} 件`}</div></div>
				{failing.length ? <button className="btn sm" onClick={() => setSub('checks')}>詳しく</button> : <span />}
			</div>
			{d.state === 'merged' ? (
				<div className="merge-row"><span className="merge-ic merged"><Icon name="merge" /></span><div><div className="t">マージされました</div><div className="d">タスクは完了になります</div></div><span /></div>
			) : d.state === 'draft' ? (
				<>
					{d.mergeable === 'conflicting' && <div className="merge-row"><span className="merge-ic ng"><Icon name="merge" /></span><div><div className="t">衝突があります</div><div className="d">{d.base} ← {d.head}。レビュー待ちにする前に、衝突を解消してください</div></div><span /></div>}
					<div className="merge-row">
						<span className="merge-ic draft"><Icon name="pr" /></span>
						<div><div className="t">ドラフトです</div><div className="d">準備ができたら、レビュー待ちにしてレビューを受けます</div></div>
						{d.simulated ? <span /> : <button className="btn sm" onClick={() => void app.call('prReady', { taskId: task.id }, { title: 'レビュー待ちにしました', body: `#${d.number}`, tone: 'green' }).then(() => detail.reload())}>レビュー待ちにする</button>}
					</div>
				</>
			) : (
				<div className="merge-row">
					<span className={`merge-ic ${d.mergeable === 'conflicting' ? 'ng' : 'ok'}`}><Icon name="merge" /></span>
					<div><div className="t">{d.mergeable === 'conflicting' ? '衝突があります' : failing.length ? 'チェックが通るまで待ってください' : 'マージできます'}</div><div className="d">{d.base} ← {d.head}</div></div>
					{d.simulated
						? <button className="btn primary" disabled={Boolean(failing.length)} onClick={() => void app.call('markDone', { taskId: task.id }, { title: 'マージしました（シミュレーション）', body: task.title, tone: 'green' })}><Icon name="merge" />マージ</button>
						: <a className="btn primary" href={d.url} target="_blank" rel="noreferrer"><Icon name="ext" />GitHub でマージ</a>}
				</div>
			)}
		</div>
	);
	return (
		<>
			{d.simulated && <div className="note-inline"><Icon name="info" />シミュレーションが作った PR です。GitHub にはありません。</div>}
			<div className="pr-head">
				<span className={`pill ${d.state}`}><Icon name={d.state === 'merged' ? 'merge' : 'pr'} size={14} />{d.state === 'draft' ? 'Draft' : d.state === 'merged' ? 'Merged' : d.state === 'closed' ? 'Closed' : 'Open'}</span>
				<span className="t">{d.title}</span><span className="faint">#{d.number}</span>
				<span className="grow" />{detail.loading && <Spinner small />}
				<button className="btn xs ghost" onClick={detail.reload} title="読み直す"><Icon name="sync" size={12} /></button>
				{d.url && <a className="btn xs ghost" href={d.url} target="_blank" rel="noreferrer"><Icon name="ext" size={12} />GitHub</a>}
			</div>
			<div className="pr-head" style={{ marginTop: 8, fontSize: 12.5 }}>
				<span className="branch">{d.base}</span>←<span className="branch">{d.head}</span>
				<span>{d.commits.length} コミット</span><span className="add">+{d.additions}</span><span className="del">−{d.deletions}</span>
				<span className="faint">{d.author}　{ago(d.createdAt, now)}</span>
			</div>
			<nav className="subnav" role="tablist">
				{([['conv', '会話', 'comment', d.reviews.length + d.threads.length], ['checks', 'チェック', 'check', d.checks.length], ['files', '変更ファイル', 'file', d.files.length], ['commits', 'コミット', 'commit', d.commits.length]] as const).map(([id, label, icon, count]) => (
					<button key={id} role="tab" aria-selected={sub === id} className={sub === id ? 'on' : ''} onClick={() => setSub(id)}><Icon name={icon} size={14} />{label}<span className="cnt">{count}</span>{id === 'checks' && failing.length > 0 && <span className="dot" style={tone('red')} />}</button>
				))}
			</nav>
			{sub === 'conv' && <>
				<div className="cmt">
					<Avatar name={d.author} src={d.authorAvatar} large kind={!d.authorAvatar ? (d.author === 'claude' ? 'claude' : d.author === 'codex' ? 'codex' : undefined) : undefined} />
					<div className="box"><div className="box-h"><span className="who">{d.author}</span>が作成<span className="grow" /><span className="faint">{ago(d.createdAt, now)}</span></div><div className="box-b">{d.bodyHTML ? <GitHubHtml html={d.bodyHTML} /> : <Markdown source={d.body} repoUrl={repoUrl} />}</div></div>
				</div>
				{[...d.reviews.map(r => ({ at: r.at, el: (
					<div className="review" key={`r${r.at}${r.author}`}>
						<div className="review-h"><Avatar name={r.author} src={r.authorAvatar} kind={!r.authorAvatar && r.isBot ? 'bot' : undefined} /><b>{r.author}</b>{r.isBot && <span className="chip">bot</span>}が{r.state === 'approved' ? '承認しました' : r.state === 'changes' ? '変更を求めました' : r.state === 'dismissed' ? 'レビューを取り下げました' : 'コメントしました'}<span className="grow" /><span className="faint">{ago(r.at, now)}</span>{r.state === 'approved' && <span style={{ color: 'var(--green)' }}><Icon name="check" /></span>}</div>
						{(r.bodyHTML || r.body) && <div className="review-b">{r.bodyHTML ? <GitHubHtml html={r.bodyHTML} /> : <Markdown source={r.body} repoUrl={repoUrl} />}</div>}
					</div>
				) })), ...[...d.comments, ...posted.filter(p => !d.comments.some(c => c.id === p.id))].map(c => ({ at: c.createdAt, el: <CommentCard key={c.id ?? c.createdAt} comment={c} repoUrl={repoUrl} /> }))]
					.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(x => x.el)}
				{d.threads.map((t, i) => (
					<div className="review" key={`t${i}`}>
						<div className="review-h"><Icon name="file" size={13} /><span className="mono">{t.path.split('/').pop()}</span>{t.line && <span className="faint">{t.line} 行目</span>}<span className="grow" />{t.resolved ? <span className="chip">解決済み</span> : <span className="chip" style={{ color: 'var(--amber)', borderColor: 'var(--amber-line)' }}>未解決</span>}</div>
						{t.diffHunk && <div className="diff" style={{ border: 0, borderRadius: 0, borderBottom: '1px solid var(--line)' }}><Diff patch={t.diffHunk} maxRows={6} /></div>}
						<div className="review-b"><div className="side-row" style={{ marginBottom: 6 }}><Avatar name={t.author} src={t.authorAvatar} /><b>{t.author}</b></div>{t.bodyHTML ? <GitHubHtml html={t.bodyHTML} /> : <Markdown source={t.body} repoUrl={repoUrl} />}</div>
					</div>
				))}
				{!d.reviews.length && !d.threads.length && !d.comments.length && <p className="faint" style={{ marginTop: 14 }}>まだレビューやコメントはありません。</p>}
				<div className="timeline" style={{ marginTop: 16 }}>
					{d.commits.slice(-8).map(c => <div className="ev" key={c.sha}><span className="evi"><Icon name="commit" size={13} /></span><Avatar name={c.author} src={c.authorAvatar} /><span className="mono faint">{c.sha}</span><span style={{ color: 'var(--text)' }}>{c.message}</span><span className="when">{c.author}　{ago(c.at, now)}</span></div>)}
				</div>
				{d.state !== 'merged' && d.state !== 'closed' && <div style={{ marginTop: 14 }}><Composer task={task} target="pr" me={app.snapshot.github.login} meAvatar={app.snapshot.github.avatarUrl} repoUrl={repoUrl} onPosted={c => { setPosted(list => [...list, c]); detail.reload(); }} /></div>}
			</>}
			{sub === 'checks' && (
				<div className="box">
					<div className="box-h"><CiIcon state={failing.length ? 'failure' : pending.length ? 'pending' : d.checks.length ? 'success' : 'none'} /><b>{failing.length ? '失敗したチェックがあります' : pending.length ? 'チェックを実行しています' : d.checks.length ? 'すべてのチェックが通りました' : 'チェックはありません'}</b><span className="grow" /><span>{passed} / {d.checks.length} 通過</span></div>
					{[...failing, ...pending, ...d.checks.filter(c => !failing.includes(c) && !pending.includes(c))].map((c, i) => (
						<div className="check" key={i}>
							<CiIcon state={c.state} />
							<div style={{ minWidth: 0 }}><div className="nm">{c.name}</div>{c.detail && <div className="dt">{c.detail}</div>}</div>
							<span className="faint num">{c.durationSec !== undefined ? duration(c.durationSec * 1000) : c.state === 'pending' ? '実行中' : c.state === 'queued' ? '待機中' : ''}</span>
							{c.url ? <a className="btn xs" href={c.url} target="_blank" rel="noreferrer">詳細</a> : c.state === 'failure' ? <button className="btn xs" onClick={() => app.setTab('terminal')}>ログ</button> : <span />}
						</div>
					))}
				</div>
			)}
			{sub === 'files' && <>
				<div className="filelist">
					{d.files.map(f => (
						<button key={f.path} className={`fl ${f.path === selected ? 'on' : ''}`} onClick={() => setFile(f.path)} title={f.path}>
							<Icon name="file" size={13} /><span className="p">{f.path}</span>
							<DiffStat add={f.additions} del={f.deletions} />
							<span><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
						</button>
					))}
				</div>
				{selected && <div className="diff"><div className="diff-h"><Icon name="file" size={13} /><span className="ellipsis mono">{selected}</span></div><FilePatch task={task} path={selected} /></div>}
			</>}
			{sub === 'commits' && (
				<div className="box">{d.commits.map(c => <div className="commit" key={c.sha}><Avatar name={c.author} src={c.authorAvatar} /><span className="msg">{c.message}</span><span className="faint">{c.author}</span><span className="sha">{c.sha}　{ago(c.at, now)}</span></div>)}</div>
			)}
			{merge}
			{task.status === 'failed' && <div className="sticky-act"><button className="btn primary" onClick={() => actions.sendBack(task, app.flowOf(task).steps.find(s => s.id === task.step)?.onFail)}><Icon name="undo" />実装へ戻す</button><button className="btn" onClick={() => void app.call('retry', { taskId: task.id, from: task.step, attempt: task.attempt })}><Icon name="retry" />やり直す</button></div>}
		</>
	);
}

/* ======================================================================
   進捗
   ====================================================================== */

/** PR を作る工程が未コミットの変更で止まったとき、コミットして続けるかを人に聞く。 */
function CommitPrompt({ task, flow }: { task: ITaskBoardTask; flow: ITaskBoardFlow }) {
	const app = useApp();
	const actions = useTaskActions();
	const files = task.uncommitted ?? [];
	const [message, setMessage] = useState(() => task.issue ? `${task.title} (#${task.issue.number})` : task.title);
	const [busy, setBusy] = useState(false);
	const step = flow.steps.find(s => s.id === task.step);
	const commit = async (trackedOnly: boolean) => {
		setBusy(true);
		await app.call('commitAndRetry', { taskId: task.id, message, attempt: task.attempt, trackedOnly }, { title: 'コミットして続けます', body: message, tone: 'green' });
		setBusy(false);
	};
	return (
		<div className="ask amber">
			<div className="ask-h"><Icon name="warning" size={14} />コミットしていない変更があります</div>
			<div className="ask-q">{step?.name ?? 'この工程'}の前に、作業場所の変更をコミットしますか。コミットすると、この工程をやり直します。</div>
			<ul className="commit-files mono">{files.slice(0, 12).map(f => <li key={f}>{f}{task.untracked?.includes(f) && <span className="chip new-file">新規</span>}</li>)}{files.length > 12 && <li className="faint">ほか {files.length - 12} 件</li>}</ul>
			<label className="faint" htmlFor="commit-msg">コミットのメッセージ</label>
			<input id="commit-msg" className="input" value={message} onChange={e => setMessage(e.target.value)} />
			<div className="ask-foot">
				<button className="btn primary" disabled={busy || !message.trim()} onClick={() => void commit(false)}><Icon name="check" size={14} />すべてコミットして続ける</button>
				<button className="btn" disabled={busy || !message.trim() || files.every(f => task.untracked?.includes(f))} onClick={() => void commit(true)} title="エージェントが新しく作ったファイルは入れず、もとからあるファイルの変更だけをコミットします">変更したファイルだけコミット</button>
				{step?.onFail ? <button className="btn" onClick={() => actions.sendBack(task, step.onFail)}><Icon name="undo" size={14} />{stepName(flow, step.onFail)}へ戻す</button> : <button className="btn" onClick={() => actions.sendBack(task)}><Icon name="undo" size={14} />差し戻す</button>}
				<button className="btn ghost" onClick={() => app.setTab('terminal')}>ターミナルを見る</button>
			</div>
		</div>
	);
}

export function ProgressTab({ task, flow }: { task: ITaskBoardTask; flow: ITaskBoardFlow }) {
	const app = useApp();
	const actions = useTaskActions();
	const now = useNow();
	const [pick, setPick] = useState<number>(0);
	const [text, setText] = useState('');
	const [feedAll, setFeedAll] = useState(false);
	const [busy, setBusy] = useState(false);
	const index = flow.steps.findIndex(s => s.id === task.step);
	const step = flow.steps[index];
	useEffect(() => {
		setPick(0);
		setText('');
	}, [task.question?.id]);
	const send = async () => {
		setBusy(true);
		await actions.answer(task, pick >= 0 ? pick : undefined, pick < 0 ? text : undefined);
		setBusy(false);
	};
	let top: ReactNode = null;
	const q = task.question;
	if ((task.status === 'question' || task.status === 'permission') && q) {
		top = (
			<div className="ask">
				<div className="ask-h"><Icon name="comment" size={14} />{q.kind === 'permission' ? '許可を求めています' : '質問'}<AgentTag agent={task.agent} /><span className="grow" /><span className="faint num">{ago(q.askedAt, now)}</span></div>
				<div className="ask-q">{q.text}</div>
				<div role="radiogroup" aria-label="回答">
					{q.options.map((o, i) => (
						<button key={i} role="radio" aria-checked={pick === i} className={`opt ${pick === i ? 'on' : ''}`} onClick={() => setPick(i)}>
							<span className="dotr" /><span className="ot">{o.label}{o.detail && <small>{o.detail}</small>}</span>
							{o.artifactId && <span className="btn xs ghost" role="link" onClick={e => { e.stopPropagation(); app.setTab('mock'); }}><Icon name="mock" size={12} />モック</span>}
						</button>
					))}
					{q.allowText && <button role="radio" aria-checked={pick === -1} className={`opt ${pick === -1 ? 'on' : ''}`} onClick={() => setPick(-1)}><span className="dotr" /><span className="ot">自分で書く<small>選ぶと下に入力欄が出ます</small></span></button>}
				</div>
				{pick === -1 && <textarea className="input" style={{ marginTop: 8 }} value={text} onChange={e => setText(e.target.value)} placeholder="エージェントへの回答" autoFocus onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { void send(); } }} />}
				<div className="ask-foot">
					<button className="btn primary" disabled={busy || (pick === -1 && !text.trim())} onClick={send}><Icon name="send" size={14} />回答を送る</button>
					<span className="faint">{task.place ? 'ターミナルのエージェントに届きます' : ''}{pick === -1 ? '（⌘Enter で送信）' : ''}</span>
				</div>
			</div>
		);
	} else if (task.status === 'working' || task.status === 'preparing') {
		const tools = task.activities.filter(a => a.kind === 'tool').slice(-6);
		top = (
			<div className="livebox">
				<div className="livebox-h"><Spinner /><b>{taskActivity(task, flow)}</b><span className="grow" />
					{task.contextPct !== undefined && <span className="ctxbar" title="コンテキストの使用率">コンテキスト<span className="bar2"><i className={task.contextPct > 75 ? 'hot' : ''} style={{ width: `${task.contextPct}%` }} /></span>{task.contextPct}%</span>}
				</div>
				{tools.length > 0 && <div className="tools-stream">{tools.map((t, i) => <div key={i}><b>{t.label}</b><span>{t.detail}</span></div>)}</div>}
				<div className="facts">
					{task.agent && <span><AgentTag agent={task.agent} short /></span>}
					{task.model && <span className="mono">{task.model}</span>}
					<span>ツール {task.activities.filter(a => a.kind === 'tool').length} 回</span>
					<span>この工程 <Elapsed since={task.stepSince} /></span>
					{step?.kind === 'agent' && <span className="grow" />}
					{step?.kind === 'agent' && <button className="btn xs" onClick={() => app.setTab('terminal')}><Icon name="term" size={12} />ターミナル</button>}
				</div>
			</div>
		);
	} else if (task.status === 'stalled') {
		top = (
			<div className="ask amber">
				<div className="ask-h"><Icon name="warning" size={14} />報告なしで止まりました</div>
				<div className="ask-q">{task.error === 'restarted' ? errorText('restarted') : 'エージェントのターンが board_complete_step の報告なしで終わりました'}</div>
				<div className="ask-foot">
					{task.error !== 'restarted' && <button className="btn primary" onClick={() => void app.call('nudge', { taskId: task.id }, { title: '報告を促しました', tone: 'blue' })}>報告を促す</button>}
					<button className={`btn ${task.error === 'restarted' ? 'primary' : ''}`} onClick={() => void app.call('retry', { taskId: task.id, from: task.step, attempt: task.attempt })}><Icon name="retry" size={14} />工程をやり直す</button>
					<button className="btn" onClick={() => actions.move(task, flow.steps[index + 1]?.id ?? 'done')}>完了扱いにする</button>
					<button className="btn ghost" onClick={() => app.setTab('terminal')}>ターミナルを見る</button>
				</div>
			</div>
		);
	} else if (task.status === 'failed' && task.uncommitted?.length) {
		top = <CommitPrompt task={task} flow={flow} />;
	} else if (task.status === 'failed') {
		top = (
			<div className="ask">
				<div className="ask-h"><Icon name="x" size={14} />失敗</div>
				<div className="ask-q">{taskActivity(task, flow)}</div>
				<div className="ask-foot">
					{step?.onFail && <button className="btn primary" onClick={() => actions.sendBack(task, step.onFail)}><Icon name="undo" size={14} />{stepName(flow, step.onFail)}へ戻す</button>}
					<button className="btn" onClick={() => void app.call('retry', { taskId: task.id, from: task.step, attempt: task.attempt })}><Icon name="retry" size={14} />やり直す</button>
					<button className="btn" onClick={() => actions.move(task, flow.steps[index + 1]?.id ?? 'done')}>無視して進める</button>
					<button className="btn ghost" onClick={() => app.setTab(task.pr ? 'pr' : 'terminal')}>{task.pr ? 'PR のチェック' : 'ログ'}を見る</button>
				</div>
			</div>
		);
	} else if (task.status === 'queued') {
		top = <div className="livebox gray"><div className="livebox-h"><Icon name="clock" /><b>作業場所の空きを待っています</b><span className="grow" /><span className="faint">空いたら自動で始めます</span></div></div>;
	} else if (task.status === 'approval') {
		top = <div className="livebox amber"><div className="livebox-h"><Icon name="plan" /><b>{step?.name}を待っています</b><span className="grow" /><button className="btn sm" onClick={() => actions.sendBack(task)}>差し戻す</button><button className="btn sm primary" onClick={() => app.setTab('plan')}>計画を開く</button></div></div>;
	} else if (task.status === 'waiting') {
		top = <div className="livebox gray"><div className="livebox-h"><Spinner t="gray" /><b>{taskActivity(task, flow)}</b><span className="grow" />{task.pr && <button className="btn sm" onClick={() => app.setTab('pr')}>PR を見る</button>}</div></div>;
	} else if (task.status === 'ready') {
		top = <div className="livebox" style={{ borderColor: 'color-mix(in srgb, var(--green) 40%, transparent)', background: 'var(--green-weak)' }}><div className="livebox-h"><Icon name="merge" /><b>マージを待っています</b><span className="grow" /><button className="btn sm primary" onClick={() => app.setTab(task.pr ? 'pr' : 'artifacts')}>確認する</button></div></div>;
	}
	if (task.step === 'todo') {
		return <Empty title="まだ着手していません">概要の「着手する」か、カードを「{flow.steps[0].name}」の列へドラッグすると始まります。<div style={{ marginTop: 14 }}><button className="btn primary" onClick={() => actions.start(task)}><Icon name="play" />着手する</button></div></Empty>;
	}
	const statusTone = task.status === 'question' || task.status === 'permission' || task.status === 'failed' ? 'red' : task.status === 'approval' || task.status === 'stalled' ? 'amber' : task.status === 'ready' ? 'green' : task.status === 'waiting' || task.status === 'queued' ? 'gray' : 'blue';
	const feed = [...task.activities].reverse();
	return (
		<>
			{top}
			<div className="box">
				<div className="box-h"><b>工程</b><span className="grow" /><span>フロー {flow.name}</span></div>
				<div className="steps-v" style={tone(statusTone)}>
					{flow.steps.map((s, i) => {
						const entries = task.history.filter(h => h.stepId === s.id);
						const last = entries.at(-1);
						const state = task.step === 'done' || i < index ? (last?.result === 'skipped' ? 's' : 'd') : i === index ? 'c' : 'p';
						const backs = entries.filter(h => h.result === 'sentBack').length;
						const arts = task.artifacts.filter(a => a.stepId === s.id);
						return (
							<div key={s.id} className={`sv ${state}`}>
								<span className="ic">{state === 'd' && <Icon name="check" />}</span>
								<div>
									<div className="nm">{s.name}{state !== 'p' && state !== 's' && <StepAgent step={s} task={task} />}{backs > 0 && <span className="chip" style={{ color: 'var(--amber)', borderColor: 'var(--amber-line)' }}>差し戻し {backs}</span>}</div>
									{state === 'c' && <div className="sub" style={{ color: 'var(--tone)' }}>{taskActivity(task, flow) || ''}</div>}
									{state === 's' && <div className="sub">飛ばしました</div>}
									{state === 'd' && last?.note && last.note !== 'manual' && <div className="sub">{last.note}</div>}
									{state === 'd' && last?.note === 'manual' && <div className="sub">手で完了にしました</div>}
									{state === 'p' && <div className="sub">{completionRule(s)}</div>}
									{arts.length > 0 && <div className="arts">
										{arts.some(a => a.kind === 'plan' || a.kind === 'report') && <span className="chip click" onClick={() => app.setTab('plan')}><Icon name="plan" size={11} />{arts.find(a => a.kind === 'plan' || a.kind === 'report')!.title}</span>}
										{arts.some(a => a.kind === 'mock') && <span className="chip click" onClick={() => app.setTab('mock')}><Icon name="mock" size={11} />モック {arts.filter(a => a.kind === 'mock').length}</span>}
										{arts.some(a => a.kind === 'screenshot') && <span className="chip click" onClick={() => app.setTab('artifacts')}><Icon name="art" size={11} />スクショ {arts.filter(a => a.kind === 'screenshot').length}</span>}
									</div>}
									{s.kind === 'run' && s.run === 'draft-pr' && task.pr && state === 'd' && <div className="arts"><span className="chip click" onClick={() => app.setTab('pr')}><Icon name="pr" size={11} />#{task.pr.number}</span></div>}
								</div>
								<div className="right">
									{state === 'd' && last ? <>{timeOfDay(last.endedAt)}<br />{duration(last.endedAt - last.startedAt)}</> : state === 'c' ? <Elapsed since={task.stepSince} /> : <span className="kind">{KIND[s.kind].label}</span>}
								</div>
							</div>
						);
					})}
				</div>
			</div>
			{step?.kind === 'agent' && (
				<div className="box">
					<div className="box-h"><b>この工程の指示</b><span className="grow" /><span className="faint">{task.stepPrompt !== undefined ? 'エージェントに送った指示' : 'フロー定義から'}</span></div>
					<div className="box-b mono" style={{ whiteSpace: 'pre-wrap' }}>{task.stepPrompt ?? ((step.prompt ?? '').replace(/\{issue\}/g, task.issue ? `#${task.issue.number}「${task.title}」` : `「${task.title}」`) || '（指示なし）')}</div>
				</div>
			)}
			{feed.length > 0 && (
				<div className="box">
					<div className="box-h"><b>経過</b><span className="badge soft">{feed.length}</span></div>
					<div className="box-b" style={{ padding: '6px 16px' }}>
						<ul className="feed">
							{(feedAll ? feed : feed.slice(0, 25)).map((a, i) => (
								<li key={i}>
									<span className="faint num">{timeOfDay(a.at)}</span>
									<span className={`k ${a.kind}`}>{a.kind === 'tool' ? a.label : { message: '発言', answer: '回答', input: '送信', system: 'ボード', error: 'エラー' }[a.kind] ?? a.kind}</span>
									<span className="d">{a.kind === 'tool' ? a.detail : a.kind === 'system' ? ({ started: `着手（${a.detail ?? ''}）`, adopted: `取り込み（${a.detail ?? ''}）`, merged: `マージ ${a.detail ?? ''}`, 'flow-changed': 'フローの変更で未着手に戻しました' }[a.label] ?? a.label) : a.label === 'nudge' ? '報告を促しました' : <b>{a.label}</b>}</span>
								</li>
							))}
						</ul>
						{feed.length > 25 && !feedAll && <button className="col-more" onClick={() => setFeedAll(true)}>すべて表示（{feed.length}）</button>}
					</div>
				</div>
			)}
		</>
	);
}

/* ======================================================================
   計画
   ====================================================================== */

function ArtifactText({ task, artifact, repoUrl }: { task: ITaskBoardTask; artifact: ITaskBoardArtifact; repoUrl?: string }) {
	// HTML で書かれた計画は、モックと同じくスクリプトを止めた枠で見せる（文字として出すと CSS が並ぶ）
	if (/\.html?$/i.test(artifact.path ?? '')) {
		return <iframe className="plan-frame" sandbox="" src={artifactUrl(task.id, artifact.id)} title={artifact.title} />;
	}
	return <ArtifactMarkdown task={task} artifact={artifact} repoUrl={repoUrl} />;
}

function ArtifactMarkdown({ task, artifact, repoUrl }: { task: ITaskBoardTask; artifact: ITaskBoardArtifact; repoUrl?: string }) {
	const text = useAsync(() => fetchText(artifactUrl(task.id, artifact.id)), [task.id, artifact.id, artifact.createdAt]);
	if (text.loading && !text.data) {
		return <Skeleton lines={6} />;
	}
	if (text.error) {
		return <LoadError error={text.error} retry={text.reload} />;
	}
	if (/^\s*(<!doctype html|<html)/i.test(text.data ?? '')) {
		return <iframe className="plan-frame" sandbox="" src={artifactUrl(task.id, artifact.id)} title={artifact.title} />;
	}
	return <Markdown source={text.data ?? ''} repoUrl={repoUrl} />;
}

export function PlanTab({ task, flow }: { task: ITaskBoardTask; flow: ITaskBoardFlow }) {
	const app = useApp();
	const actions = useTaskActions();
	const now = useNow();
	const docs = task.artifacts.filter(a => a.kind === 'plan' || a.kind === 'report');
	const [id, setId] = useState<string>();
	const [note, setNote] = useState('');
	const [busy, setBusy] = useState(false);
	const doc = docs.find(a => a.id === id) ?? docs.find(a => a.kind === 'plan') ?? docs[0];
	const step = flow.steps.find(s => s.id === task.step);
	const next = flow.steps[flow.steps.findIndex(s => s.id === task.step) + 1];
	if (!doc) {
		return <Empty title="まだ計画はありません">「{flow.steps.find(s => s.kind === 'agent')?.name ?? '調査'}」の工程でエージェントが書き、board_complete_step で添付します。</Empty>;
	}
	return (
		<>
			{docs.length > 1 && <nav className="subnav top0">{docs.map(a => <button key={a.id} className={a.id === doc.id ? 'on' : ''} onClick={() => setId(a.id)}><Icon name="plan" size={13} />{a.title}<span className="cnt">{stepName(flow, a.stepId)}</span></button>)}</nav>}
			<div className="box">
				<div className="box-h"><Icon name="plan" size={14} /><span className="mono ellipsis">{doc.path ?? doc.title}</span><span className="grow" /><StepAgent step={flow.steps.find(s => s.id === doc.stepId) ?? flow.steps[0]} task={task} /><span className="faint">{stepName(flow, doc.stepId)}　{ago(doc.createdAt, now)}</span></div>
				<div className="box-b"><ArtifactText task={task} artifact={doc} repoUrl={task.issue ? `https://github.com/${task.issue.owner}/${task.issue.repo}` : undefined} /></div>
			</div>
			{task.status === 'approval' && step?.kind === 'human' && (
				<div className="approve-bar">
					<div className="approve-card">
						<div style={{ minWidth: 0 }}>
							<b>この計画で進めますか</b>
							<div className="opts">{next ? <span>承認すると「{next.name}」（<StepAgent step={next} task={task} />）を始めます</span> : <span>承認すると完了します</span>}</div>
							<input className="input" style={{ marginTop: 8 }} value={note} onChange={e => setNote(e.target.value)} placeholder="ひとこと添える（任意。エージェントへの補足として残ります）" />
						</div>
						<div className="btns">
							<button className="btn" onClick={() => actions.sendBack(task)}><Icon name="undo" size={14} />差し戻す</button>
							<button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await actions.approve(task, note.trim() || undefined); setBusy(false); app.setTab('progress'); }}><Icon name="check" size={14} />承認して次へ</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

/* ======================================================================
   モック
   ====================================================================== */

const WIDTHS = [{ w: 1280, label: 'デスクトップ', icon: 'monitor', scale: 760 }, { w: 768, label: 'タブレット', icon: 'tablet', scale: 560 }, { w: 390, label: 'モバイル', icon: 'device', scale: 360 }] as const;

export function MockTab({ task }: { task: ITaskBoardTask }) {
	const actions = useTaskActions();
	const now = useNow();
	const mocks = task.artifacts.filter(a => a.kind === 'mock');
	const [index, setIndex] = useState(0);
	const [width, setWidth] = useStored<number>('mockWidth', 1280);
	const [compare, setCompare] = useState(false);
	if (!mocks.length) {
		return <Empty title="モックはありません">エージェントが board_complete_step や board_ask_human に HTML を添えると、ここに並びます。</Empty>;
	}
	const current = mocks[Math.min(index, mocks.length - 1)];
	const optionIndex = task.question?.options.findIndex(o => o.artifactId === current.id) ?? -1;
	const size = WIDTHS.find(x => x.w === width) ?? WIDTHS[0];
	const frame = (m: ITaskBoardArtifact, w: number) => (
		<div className="device" style={{ width: w }} key={m.id}>
			<div className="device-bar"><i /><i /><i /><span className="ellipsis" style={{ marginLeft: 6 }}>{m.path ?? m.title}</span></div>
			{/* sandbox は空: スクリプトも親の画面へのアクセスも許さない */}
			<iframe sandbox="" src={artifactUrl(task.id, m.id)} title={m.title} />
		</div>
	);
	return (
		<>
			<div className="mock-thumbs">
				{mocks.map((m, i) => (
					<button key={m.id} className={`thumb ${i === index && !compare ? 'on' : ''}`} onClick={() => { setIndex(i); setCompare(false); }}>
						<div className="tv"><iframe sandbox="" src={artifactUrl(task.id, m.id)} tabIndex={-1} title="" /></div>
						<div className="tl"><span className="ellipsis">{m.title}</span><span className="faint">{ago(m.createdAt, now)}</span></div>
					</button>
				))}
			</div>
			<div className="mock-top">
				<div className="seg">{WIDTHS.map(x => <button key={x.w} className={!compare && width === x.w ? 'on' : ''} onClick={() => { setWidth(x.w); setCompare(false); }}><Icon name={x.icon} size={13} />{x.label}</button>)}</div>
				{mocks.length > 1 && <button className={`btn sm ${compare ? 'primary' : ''}`} onClick={() => setCompare(!compare)}><Icon name="compare" size={13} />並べて比べる</button>}
				<span className="grow" />
				{!compare && optionIndex >= 0 && (task.status === 'question' || task.status === 'permission') && <button className="btn primary sm" onClick={() => void actions.answer(task, optionIndex)}>この案で回答する</button>}
				<a className="btn sm ghost" href={artifactUrl(task.id, current.id)} target="_blank" rel="noreferrer"><Icon name="ext" size={13} />別のタブで開く</a>
			</div>
			<div className="stage">{compare ? mocks.slice(0, 3).map(m => frame(m, 420)) : frame(current, size.scale)}</div>
		</>
	);
}

/* ======================================================================
   成果物
   ====================================================================== */

export function ArtifactsTab({ task }: { task: ITaskBoardTask }) {
	const app = useApp();
	const actions = useTaskActions();
	const now = useNow();
	const shots = task.artifacts.filter(a => a.kind === 'screenshot');
	const reports = task.artifacts.filter(a => a.kind === 'report');
	const [sub, setSub] = useState<'shots' | 'compare' | 'reports'>('shots');
	const [split, setSplit] = useState(50);
	const [pair, setPair] = useState<[number, number]>([0, Math.max(0, shots.length - 1)]);
	if (!shots.length && !reports.length) {
		return <Empty title="まだ成果物はありません">スクショ・レビュー結果などがここに集まります。PR は「PR」のタブで見られます。</Empty>;
	}
	return (
		<>
			<nav className="subnav top0">
				<button className={sub === 'shots' ? 'on' : ''} onClick={() => setSub('shots')}><Icon name="art" size={13} />スクショ<span className="cnt">{shots.length}</span></button>
				{shots.length > 1 && <button className={sub === 'compare' ? 'on' : ''} onClick={() => setSub('compare')}><Icon name="compare" size={13} />2 枚を比べる</button>}
				<button className={sub === 'reports' ? 'on' : ''} onClick={() => setSub('reports')}><Icon name="plan" size={13} />レポート<span className="cnt">{reports.length}</span></button>
			</nav>
			{sub === 'shots' && (shots.length ? (
				<div className="gallery">
					{shots.map(s => <button key={s.id} className="shot" onClick={() => app.showDialog(<ImageDialog src={artifactUrl(task.id, s.id)} title={s.title} />)}><img src={artifactUrl(task.id, s.id)} alt={s.title} loading="lazy" /><span className="ellipsis">{s.title}　<span className="faint">{ago(s.createdAt, now)}</span></span></button>)}
				</div>
			) : <Empty title="スクショはありません" />)}
			{sub === 'compare' && shots.length > 1 && <>
				<div className="mock-top">
					<select className="input" style={{ width: 'auto' }} value={pair[0]} onChange={e => setPair([Number(e.target.value), pair[1]])}>{shots.map((s, i) => <option key={s.id} value={i}>左: {s.title}</option>)}</select>
					<select className="input" style={{ width: 'auto' }} value={pair[1]} onChange={e => setPair([pair[0], Number(e.target.value)])}>{shots.map((s, i) => <option key={s.id} value={i}>右: {s.title}</option>)}</select>
				</div>
				<div className="compare" style={{ ['--split' as string]: `${split}%` }}>
					<img src={artifactUrl(task.id, shots[pair[0]].id)} alt={shots[pair[0]].title} />
					<img className="after" src={artifactUrl(task.id, shots[pair[1]].id)} alt={shots[pair[1]].title} />
					<span className="tagl">{shots[pair[0]].title}</span><span className="tagr">{shots[pair[1]].title}</span>
					<div className="handle" />
					<input type="range" min={0} max={100} value={split} onChange={e => setSplit(Number(e.target.value))} aria-label="比べる位置" />
				</div>
			</>}
			{sub === 'reports' && (reports.length ? reports.map(r => (
				<div className="box" key={r.id}><div className="box-h"><b>{r.title}</b><span className="grow" /><span className="faint">{ago(r.createdAt, now)}</span></div><div className="box-b"><ArtifactText task={task} artifact={r} /></div></div>
			)) : <Empty title="レポートはありません" />)}
			{task.status === 'ready' && !task.pr && <div className="sticky-act"><button className="btn primary" onClick={() => void app.call('markDone', { taskId: task.id }, { title: '完了にしました', tone: 'green' })}><Icon name="check" />完了にする</button><button className="btn" onClick={() => actions.sendBack(task)}>直してほしい点を送る</button></div>}
		</>
	);
}

/* ======================================================================
   ターミナル
   ====================================================================== */

function termLine(line: string): ReactNode {
	const cls = /^\s*(✓|✔)/.test(line) ? 'g' : /^\s*(✗|✖|×)|failing|Error/.test(line) ? 'r' : /^\s*\?/.test(line) ? 'y' : /^(●|◆)/.test(line) ? 'c' : /^\s*⎿/.test(line) ? 'f' : /^›/.test(line) ? 'b' : /\$ /.test(line) ? 'f' : '';
	return cls ? <span className={cls}>{line}</span> : line;
}

export function TerminalTab({ task }: { task: ITaskBoardTask }) {
	const app = useApp();
	const [input, setInput] = useState('');
	const ref = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const live = Boolean(task.place) && ['working', 'question', 'permission', 'stalled'].includes(task.status);
	const slot = task.place ? (task.place.startsWith('manual:') ? task.place.slice(7) : app.snapshot.slots.find(s => s.id === task.place)?.name ?? task.place) : undefined;
	useEffect(() => {
		const el = ref.current;
		if (el && stick.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [task.log.length, task.updatedAt]);
	const lines = useMemo(() => task.log.map((l, i) => <div key={i}>{termLine(l)}</div>), [task.log]);
	const send = async () => {
		const text = input.trim();
		if (!text) {
			return;
		}
		setInput('');
		await app.call('sendInput', { taskId: task.id, text });
	};
	return (
		<>
			<div className="termwin">
				<div className="term-h">
					<Icon name="term" size={14} /><span className="mono">{slot ?? '作業場所なし'}</span>
					{task.agent && <AgentTag agent={task.agent} />}{task.model && <span className="mono">{task.model}</span>}
					<span className="grow" />
					{live ? <span className="status live" style={tone('blue')}>つながっています</span> : <span className="status" style={tone('gray')}>止まっています</span>}
					{task.contextPct !== undefined && <span className="ctxbar">コンテキスト<span className="bar2"><i style={{ width: `${task.contextPct}%` }} /></span>{task.contextPct}%</span>}
				</div>
				<div className="term" ref={ref} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} role="log" aria-live="polite">
					{lines.length ? lines : <span className="f">まだ出力はありません</span>}
				</div>
				<div className="term-in">
					<span className="mono" style={{ color: 'var(--accent)' }}>›</span>
					<input className="input" value={input} disabled={!task.place} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { void send(); } }} placeholder={task.place ? 'エージェントに送る（Enter）' : '作業場所がありません'} aria-label="エージェントに送る" />
					<button className="btn sm primary" disabled={!task.place || !input.trim()} onClick={send}><Icon name="send" size={13} />送る</button>
				</div>
			</div>
			<div className="keys">
				キー: {['Esc', 'Enter', '↑', '↓', '1', '2', '3', 'Ctrl+C'].map(k => <button key={k} disabled={!task.place} onClick={() => void app.call('sendKey', { taskId: task.id, key: k })}>{k}</button>)}
				<span className="grow" />
				<span>{app.snapshot.runtime.agents === 'simulated' ? 'シミュレーションの出力です' : `Para Code のスペース「${slot ?? '-'}」のターミナル`}</span>
			</div>
		</>
	);
}
