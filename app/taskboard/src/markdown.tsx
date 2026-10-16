// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, useState, type ReactNode } from 'react';
import { imageProxyUrl } from './githubHtml.js';

/*
 * GitHub の Issue・PR・計画を表示するための小さな Markdown。
 * HTML は解釈せず（<img> と <br> だけ画像・改行にする）、リンクは http(s) だけを通す。
 * dangerouslySetInnerHTML を使わないので、本文に何が書かれていても画面に入り込まない。
 */

interface IContext {
	/** `#123` を Issue へのリンクにするときの土台（https://github.com/o/r）。 */
	readonly repoUrl?: string;
}

function safeUrl(url: string): string | undefined {
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|<img\s[^>]*src="([^"]+)"[^>]*>|<br\s*\/?>|(?<![\w/])@([A-Za-z0-9-]{1,39})(?![\w-])|(?<![\w/&])#(\d{1,7})(?!\w)/g;

/** 読めない画像（非公開リポジトリの添付など）は、壊れた画像の代わりにリンクを出す。 */
function MdImage({ src, alt }: { src: string; alt: string }) {
	const [failed, setFailed] = useState(false);
	const shown = imageProxyUrl(src) ?? src;
	if (failed) {
		return <a className="md-img-fallback" href={src} target="_blank" rel="noreferrer noopener">画像: {alt || src.replace(/^https?:\/\//, '').slice(0, 48)}</a>;
	}
	return <img src={shown} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function inline(text: string, ctx: IContext, keyBase: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let k = 0;
	const key = () => `${keyBase}-${k++}`;
	const plain = (s: string) => {
		// HTML のタグは表示しない（コメント・details など）
		const cleaned = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '');
		if (cleaned) {
			out.push(cleaned);
		}
	};
	for (const m of text.matchAll(INLINE)) {
		plain(text.slice(last, m.index));
		last = (m.index ?? 0) + m[0].length;
		if (m[1]) {
			out.push(<code key={key()}>{m[2]}</code>);
		} else if (m[4] !== undefined) {
			const url = safeUrl(m[4]);
			out.push(url ? <MdImage key={key()} src={url} alt={m[3]} /> : m[3]);
		} else if (m[5] !== undefined) {
			const url = safeUrl(m[6]);
			out.push(url ? <a key={key()} href={url} target="_blank" rel="noreferrer noopener">{inline(m[5], ctx, key())}</a> : m[5]);
		} else if (m[7] !== undefined || m[8] !== undefined) {
			out.push(<strong key={key()}>{inline(m[7] ?? m[8], ctx, key())}</strong>);
		} else if (m[9] !== undefined) {
			out.push(<del key={key()}>{m[9]}</del>);
		} else if (m[10] !== undefined || m[11] !== undefined) {
			out.push(<em key={key()}>{m[10] ?? m[11]}</em>);
		} else if (m[12] !== undefined) {
			out.push(<a key={key()} href={m[12]} target="_blank" rel="noreferrer noopener">{m[12].replace(/^https?:\/\//, '').slice(0, 60)}</a>);
		} else if (m[13] !== undefined) {
			const url = safeUrl(m[13]);
			out.push(url ? <MdImage key={key()} src={url} alt="" /> : null);
		} else if (m[0].startsWith('<br')) {
			out.push(<br key={key()} />);
		} else if (m[14] !== undefined) {
			out.push(<a key={key()} className="md-mention" href={`https://github.com/${m[14]}`} target="_blank" rel="noreferrer noopener">@{m[14]}</a>);
		} else if (m[15] !== undefined) {
			out.push(ctx.repoUrl ? <a key={key()} href={`${ctx.repoUrl}/issues/${m[15]}`} target="_blank" rel="noreferrer noopener">#{m[15]}</a> : `#${m[15]}`);
		}
	}
	plain(text.slice(last));
	return out;
}

type Block =
	| { kind: 'p'; text: string }
	| { kind: 'h'; level: number; text: string }
	| { kind: 'code'; lang: string; text: string }
	| { kind: 'quote'; lines: string[] }
	| { kind: 'list'; ordered: boolean; items: { text: string; task?: boolean; done?: boolean; depth: number }[] }
	| { kind: 'table'; head: string[]; rows: string[][]; align: ('left' | 'center' | 'right' | undefined)[] }
	| { kind: 'hr' };

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function cells(line: string): string[] {
	return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}

export function parseBlocks(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
				body.push(lines[i]);
				i++;
			}
			i++;
			blocks.push({ kind: 'code', lang: fence[2], text: body.join('\n') });
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
		if (heading) {
			blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] });
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			blocks.push({ kind: 'hr' });
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const quote: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quote.push(lines[i].replace(/^\s*>\s?/, ''));
				i++;
			}
			blocks.push({ kind: 'quote', lines: quote });
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
			const head = cells(line);
			const align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' as const : c.endsWith(':') ? 'right' as const : c.startsWith(':') ? 'left' as const : undefined);
			const rows: string[][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
				rows.push(cells(lines[i]));
				i++;
			}
			blocks.push({ kind: 'table', head, rows, align });
			continue;
		}
		const listMatch = line.match(LIST_RE);
		if (listMatch) {
			const ordered = /\d/.test(listMatch[2]);
			const items: { text: string; task?: boolean; done?: boolean; depth: number }[] = [];
			while (i < lines.length) {
				const m = lines[i].match(LIST_RE);
				if (!m) {
					if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
						items[items.length - 1].text += ` ${lines[i].trim()}`;
						i++;
						continue;
					}
					break;
				}
				const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
				items.push({ text: task ? task[2] : m[3], task: Boolean(task), done: task ? task[1] !== ' ' : undefined, depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)) });
				i++;
			}
			blocks.push({ kind: 'list', ordered, items });
			continue;
		}
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*(```|~~~|>)/.test(lines[i])) {
			para.push(lines[i]);
			i++;
		}
		blocks.push({ kind: 'p', text: para.join('\n') });
	}
	return blocks;
}

export function Markdown({ source, repoUrl, className }: { source: string; repoUrl?: string; className?: string }) {
	const ctx: IContext = { repoUrl };
	const blocks = parseBlocks(source);
	if (!blocks.length) {
		return <p className="md-empty">説明はありません。</p>;
	}
	return (
		<div className={`md ${className ?? ''}`}>
			{blocks.map((b, n) => {
				const key = `b${n}`;
				switch (b.kind) {
					case 'h': {
						const Tag = (`h${Math.min(6, b.level + 1)}`) as 'h2';
						return <Tag key={key}>{inline(b.text, ctx, key)}</Tag>;
					}
					case 'p':
						return <p key={key}>{b.text.split('\n').map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, ctx, `${key}-${j}`)}</Fragment>)}</p>;
					case 'code':
						return <pre key={key} data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
					case 'quote':
						return <blockquote key={key}><Markdown source={b.lines.join('\n')} repoUrl={repoUrl} /></blockquote>;
					case 'hr':
						return <hr key={key} />;
					case 'table':
						return (
							<div key={key} className="md-table"><table>
								<thead><tr>{b.head.map((h, j) => <th key={j} style={{ textAlign: b.align[j] }}>{inline(h, ctx, `${key}h${j}`)}</th>)}</tr></thead>
								<tbody>{b.rows.map((r, j) => <tr key={j}>{b.head.map((_, c) => <td key={c} style={{ textAlign: b.align[c] }}>{inline(r[c] ?? '', ctx, `${key}r${j}c${c}`)}</td>)}</tr>)}</tbody>
							</table></div>
						);
					case 'list': {
						const Tag = b.ordered ? 'ol' : 'ul';
						return (
							<Tag key={key} className={b.items.some(it => it.task) ? 'md-tasks' : undefined}>
								{b.items.map((it, j) => (
									<li key={j} style={it.depth ? { marginLeft: it.depth * 18 } : undefined} className={it.task ? 'md-task' : undefined}>
										{it.task && <input type="checkbox" checked={it.done} readOnly tabIndex={-1} aria-label={it.done ? '済み' : '未'} />}
										<span>{inline(it.text, ctx, `${key}-${j}`)}</span>
									</li>
								))}
							</Tag>
						);
					}
				}
			})}
		</div>
	);
}
