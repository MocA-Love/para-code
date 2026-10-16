// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ITaskBoardLabel, ITaskBoardPrRef, ITaskBoardStep, ITaskBoardTask, TaskBoardAgentKind, TaskBoardCheckState, TaskBoardStatus } from '@engine/paradisTaskBoard.js';
import { clock, dueInfo, STATUS, TONE_VAR, type Tone } from '../format.js';
import { useDismiss, useNow } from '../hooks.js';
import { Icon, type IconName } from '../icons.js';
import { PARADIS_CLAUDE_LOGO_PATH, PARADIS_CODEX_LOGO_PATH } from '@paradis-logos';

export function tone(t: Tone): CSSProperties {
	return { ['--tone' as string]: TONE_VAR[t] };
}

export function Status({ status, label }: { status: TaskBoardStatus; label?: string }) {
	const s = STATUS[status];
	return <span className={`status ${s.tone === 'blue' ? 'live' : ''}`} style={tone(s.tone)}>{label ?? s.label}</span>;
}

/** Para Code の使用量の表示と同じ、Claude Code / Codex のロゴ。 */
export function AgentLogo({ kind }: { kind: 'claude' | 'codex' }) {
	return <svg viewBox="0 0 600 600" aria-hidden="true"><path d={kind === 'claude' ? PARADIS_CLAUDE_LOGO_PATH : PARADIS_CODEX_LOGO_PATH} fill="currentColor" /></svg>;
}

export function AgentTag({ agent, short }: { agent: TaskBoardAgentKind | 'review-bot' | 'human' | 'auto' | 'any' | undefined; short?: boolean }) {
	switch (agent) {
		case 'claude': return <span className="agent"><i className="claude"><AgentLogo kind="claude" /></i>{short ? 'Claude' : 'Claude Code'}</span>;
		case 'codex': return <span className="agent"><i className="codex"><AgentLogo kind="codex" /></i>Codex</span>;
		case 'review-bot': return <span className="agent"><i className="bot">B</i>bot</span>;
		case 'human': return <span className="agent"><i className="human">人</i>あなた</span>;
		case 'auto': return <span className="agent"><i className="auto">自</i>自動</span>;
		case 'any': return <span className="agent"><i className="auto">AI</i>どれでも</span>;
		default: return null;
	}
}

export function StepAgent({ step, task }: { step: ITaskBoardStep; task?: ITaskBoardTask }) {
	if (step.kind === 'human') {
		return <AgentTag agent="human" />;
	}
	if (step.kind !== 'agent') {
		return <AgentTag agent="auto" />;
	}
	if (step.agent === 'claude' || step.agent === 'codex') {
		return <AgentTag agent={step.agent} />;
	}
	// 終わった工程は、その工程を動かしたエージェントを出す（今のエージェントは後の工程で変わりうる）
	const ran = task?.step === step.id ? undefined : task?.history.findLast(h => h.stepId === step.id && h.agent)?.agent;
	return <AgentTag agent={ran ?? (task?.step === step.id ? task.agent : undefined) ?? 'any'} />;
}

function labelColor(label: ITaskBoardLabel): string {
	if (label.color && /^[0-9a-f]{6}$/i.test(label.color)) {
		return `#${label.color}`;
	}
	let h = 0;
	for (const c of label.name) {
		h = (h * 31 + c.charCodeAt(0)) % 360;
	}
	return `hsl(${h} 60% 60%)`;
}

export function LabelChip({ label }: { label: ITaskBoardLabel }) {
	return <span className="chip label" style={{ ['--lc' as string]: labelColor(label) }} title={label.name}>{label.name}</span>;
}

export function DueChip({ due }: { due: string | undefined }) {
	const now = useNow();
	const info = dueInfo(due, now);
	if (!info) {
		return null;
	}
	return <span className={`chip due ${info.level}`} title={`締切 ${due}`}><Icon name="clock" size={11} />{info.text}</span>;
}

export function PrChip({ pr, onClick }: { pr: ITaskBoardPrRef; onClick?: () => void }) {
	return (
		<span className={`chip pr ${pr.state} ${onClick ? 'click' : ''}`} onClick={onClick ? e => { e.stopPropagation(); onClick(); } : undefined} title={pr.simulated ? 'シミュレーションの PR（GitHub にはありません）' : `PR #${pr.number}`}>
			<Icon name={pr.state === 'merged' ? 'merge' : 'pr'} size={11} />#{pr.number}{pr.simulated ? '*' : ''}
			{pr.checks !== 'none' && <CiDot state={pr.checks === 'success' ? 'success' : pr.checks === 'failure' ? 'failure' : 'pending'} />}
		</span>
	);
}

function CiDot({ state }: { state: 'success' | 'failure' | 'pending' }) {
	return <span className="dot" style={{ width: 6, height: 6, ...tone(state === 'success' ? 'green' : state === 'failure' ? 'red' : 'amber') }} />;
}

export function CiIcon({ state }: { state: TaskBoardCheckState | 'none' }) {
	if (state === 'success') {
		return <span className="ci success"><Icon name="check" /></span>;
	}
	if (state === 'failure' || state === 'cancelled') {
		return <span className="ci failure"><Icon name="x" /></span>;
	}
	if (state === 'skipped' || state === 'neutral') {
		return <span className="ci skipped"><Icon name="chevronRight" /></span>;
	}
	return <span className={`ci ${state === 'queued' || state === 'none' ? 'queued' : 'pending'}`} />;
}

export function Elapsed({ since }: { since: number }) {
	const now = useNow();
	return <span className="num">{clock(now - since)}</span>;
}

export function Avatar({ name, large, kind, src }: { name: string; large?: boolean; kind?: 'claude' | 'codex' | 'bot'; src?: string }) {
	const [failed, setFailed] = useState(false);
	const text = kind === 'claude' || kind === 'codex' ? <AgentLogo kind={kind} /> : name.replace(/\[bot\]$/, '').slice(0, 2).toUpperCase();
	const safe = src && /^https:\/\/avatars\.githubusercontent\.com\//.test(src) ? src : undefined;
	return (
		<span className={`avatar ${large ? 'lg' : ''} ${kind && !(safe && !failed) ? `k-${kind}` : ''}`} title={name}>
			{safe && !failed ? <img src={safe} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : text}
		</span>
	);
}

export function Spinner({ small, t }: { small?: boolean; t?: Tone }) {
	return <span className={`spinner ${small ? 'sm' : ''}`} style={t ? tone(t) : undefined} aria-label="読み込み中" />;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
	return <div aria-busy="true">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 17}%` }} />)}</div>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
	return (
		<label className="toggle">
			<input type="checkbox" className="sr" checked={checked} onChange={e => onChange(e.target.checked)} />
			<span className="switch" />
			{label}
		</label>
	);
}

/* ---------------- メニュー ---------------- */

export interface IMenuItem {
	readonly label: string;
	readonly icon?: IconName;
	readonly sub?: string;
	readonly danger?: boolean;
	readonly on?: boolean;
	readonly disabled?: boolean;
	readonly run?: () => void;
	readonly header?: boolean;
	readonly separator?: boolean;
}

/** メニューと、押した場所・画面の端との間。 */
const MENU_GAP = 6;

export function Menu({ items, trigger, align = 'right', label }: { items: readonly IMenuItem[]; trigger: (open: boolean, toggle: () => void) => ReactNode; align?: 'left' | 'right'; label: string }) {
	const [open, setOpen] = useState(false);
	const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
	const close = useCallback(() => setOpen(false), []);
	const pop = useRef<HTMLDivElement | null>(null);
	const ref = useDismiss(open, close, pop);
	// 親の overflow で切り取られないよう body 直下に出し、押した場所の下（入らなければ上）に置く
	useLayoutEffect(() => {
		if (!open || !ref.current || !pop.current) {
			setPlace({ visibility: 'hidden' });
			return;
		}
		const at = ref.current.getBoundingClientRect();
		const size = pop.current.getBoundingClientRect();
		const below = at.bottom + MENU_GAP;
		const fitsBelow = below + size.height <= window.innerHeight - MENU_GAP;
		const top = fitsBelow ? below : at.top - MENU_GAP - size.height >= MENU_GAP ? at.top - MENU_GAP - size.height : Math.max(MENU_GAP, window.innerHeight - MENU_GAP - size.height);
		const left = align === 'left' ? at.left : at.right - size.width;
		setPlace({ top, left: Math.max(MENU_GAP, Math.min(left, window.innerWidth - size.width - MENU_GAP)) });
	}, [open, align, ref]);
	// 置いた場所がずれるので、スクロールや幅の変化では閉じる（メニューの中のスクロールは除く）
	useEffect(() => {
		if (!open) {
			return;
		}
		// メニューの起点ごと動くスクロール（ページや起点を含む領域）でだけ閉じる。出力の自動スクロールなど、関係の無い所では閉じない
		const onScroll = (e: Event) => {
			const target = e.target;
			if (target === document || (target instanceof Node && ref.current && target.contains(ref.current))) {
				close();
			}
		};
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', close);
		return () => {
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', close);
		};
	}, [open, close]);
	return (
		<div className="menu-wrap" ref={ref} onClick={e => e.stopPropagation()}>
			{trigger(open, () => setOpen(o => !o))}
			{open && createPortal(
				<div ref={pop} className="menu" style={place} role="menu" aria-label={label} onClick={e => e.stopPropagation()}>
					{items.map((item, i) => item.separator ? <hr key={i} /> : item.header ? <div key={i} className="mh">{item.label}</div> : (
						<button key={i} role="menuitem" className={`mi ${item.danger ? 'danger' : ''} ${item.on ? 'on' : ''}`} disabled={item.disabled} onClick={() => { close(); item.run?.(); }}>
							{item.icon && <Icon name={item.icon} />}{item.label}{item.sub && <span className="sub">{item.sub}</span>}
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}
