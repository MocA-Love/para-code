// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import type { ITaskBoardComment, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { rpc } from '../api.js';
import { useApp } from '../context.js';
import { GitHubHtml } from '../githubHtml.js';
import { Icon } from '../icons.js';
import { Markdown } from '../markdown.js';
import { Avatar, Spinner } from './atoms.js';

/**
 * コメント欄。プレビューは GitHub の書式（メンションや #番号のリンク）で描き、
 * GitHub につないでいないときは手元の Markdown で描く。⌘Enter で送る。
 */
export function Composer({ task, target, me, meAvatar, onPosted, repoUrl }: { task: ITaskBoardTask; target: 'issue' | 'pr'; me?: string; meAvatar?: string; onPosted: (comment: ITaskBoardComment) => void; repoUrl?: string }) {
	const app = useApp();
	const [tab, setTab] = useState<'write' | 'preview'>('write');
	const [text, setText] = useState('');
	const [preview, setPreview] = useState<{ text: string; html: string | undefined } | undefined>();
	const [loadingPreview, setLoadingPreview] = useState(false);
	const [sending, setSending] = useState(false);
	const simulated = target === 'pr' ? Boolean(task.pr?.simulated) : !task.issue?.url;
	const showPreview = async () => {
		setTab('preview');
		if (!text.trim() || preview?.text === text) {
			return;
		}
		setLoadingPreview(true);
		try {
			const result = await rpc('renderMarkdown', { taskId: task.id, text });
			setPreview({ text, html: result.html });
		} catch {
			setPreview({ text, html: undefined });
		} finally {
			setLoadingPreview(false);
		}
	};
	const send = async () => {
		const body = text.trim();
		if (!body || sending) {
			return;
		}
		setSending(true);
		const comment = await app.call('comment', { taskId: task.id, target, body }, { title: 'コメントしました', body: body.slice(0, 80), tone: 'green' });
		setSending(false);
		if (comment) {
			setText('');
			setPreview(undefined);
			setTab('write');
			onPosted(comment);
		}
	};
	return (
		<div className="cmt">
			<Avatar name={me ?? 'you'} large src={meAvatar} />
			<div className="box composer">
				<div className="ctabs" role="tablist">
					<button role="tab" aria-selected={tab === 'write'} className={tab === 'write' ? 'on' : ''} onClick={() => setTab('write')}>書く</button>
					<button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'on' : ''} onClick={() => void showPreview()}>プレビュー</button>
					<span className="grow" />
					{simulated ? <span className="chip sim">見本（GitHub に送らない）</span> : <span className="faint" style={{ fontSize: 11.5 }}>GitHub に投稿します</span>}
				</div>
				{tab === 'write' ? (
					<textarea
						className="input"
						value={text}
						onChange={e => setText(e.target.value)}
						onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
						placeholder={target === 'pr' ? 'PR にコメントする（Markdown）' : 'Issue にコメントする（Markdown）'}
						aria-label="コメント"
					/>
				) : (
					<div className="box-b" style={{ minHeight: 96 }}>
						{loadingPreview ? <Spinner small /> : !text.trim() ? <span className="faint">プレビューする内容がありません</span> : preview?.html ? <GitHubHtml html={preview.html} /> : <Markdown source={text} repoUrl={repoUrl} />}
					</div>
				)}
				<div className="composer-foot">
					<Icon name="info" size={13} /><span>Markdown が使えます。⌘Enter で送信</span>
					<span className="grow" />
					<button className="btn sm primary" disabled={!text.trim() || sending} onClick={() => void send()}>{sending ? <Spinner small /> : <Icon name="send" size={13} />}コメント</button>
				</div>
			</div>
		</div>
	);
}
