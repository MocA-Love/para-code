// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactElement } from 'react';

/* 16px の線で描くアイコン。色は currentColor。 */

const PATHS = {
	issue: <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /></>,
	issueClosed: <><circle cx="8" cy="8" r="6" /><path d="M5.5 8.2l1.7 1.7 3.3-3.6" /></>,
	pr: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" /></>,
	progress: <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />,
	plan: <><rect x="3" y="1.8" width="10" height="12.4" rx="1.6" /><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" /></>,
	mock: <><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" /><path d="M1.8 5.5h12.4M6 5.5v8" /></>,
	art: <><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" /><circle cx="5.5" cy="6.3" r="1.2" /><path d="M2.5 12.5l3.8-3.8 2.5 2.5 2-2 3.2 3.2" /></>,
	term: <><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" /><path d="M4.5 6.5l2 1.8-2 1.8M8.5 10.5h3" /></>,
	check: <path d="M3.5 8.5l3 3 6-7" />,
	x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
	label: <><path d="M2 2.5h5.5l6.5 6.5-5 5-7-7z" /><circle cx="5" cy="5.5" r="1" /></>,
	board: <><rect x="1.8" y="2" width="4" height="12" rx="1" /><rect x="7" y="2" width="4" height="8" rx="1" /><rect x="12.2" y="2" width="2" height="5" rx="1" /></>,
	inbox: <><path d="M2 9.5l1.6-6h8.8l1.6 6v3.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" /></>,
	list: <path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5M2 4h.5M2 8h.5M2 12h.5" />,
	flow: <><rect x="1.8" y="1.8" width="5" height="3.5" rx="1" /><rect x="9.2" y="6.2" width="5" height="3.5" rx="1" /><rect x="1.8" y="10.7" width="5" height="3.5" rx="1" /><path d="M6.8 3.5h1.5a1 1 0 0 1 1 1v1.7M9.2 9.5H8.3a1 1 0 0 0-1 1v1.9" /></>,
	person: <><circle cx="8" cy="5.5" r="2.8" /><path d="M2.5 14c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" /></>,
	branch: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="5" r="1.6" /><path d="M4 5.1v5.8M12 6.6c0 3-4 2.5-7 4.6" /></>,
	ext: <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />,
	expand: <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" />,
	collapse: <path d="M6 2.5V6H2.5M10 2.5V6h3.5M6 13.5V10H2.5M10 13.5V10h3.5" />,
	close: <path d="M4 4l8 8M12 4l-8 8" />,
	dots: <><circle cx="3.5" cy="8" r=".8" fill="currentColor" /><circle cx="8" cy="8" r=".8" fill="currentColor" /><circle cx="12.5" cy="8" r=".8" fill="currentColor" /></>,
	chevron: <path d="M4 6l4 4 4-4" />,
	chevronLeft: <path d="M10 3.5L5.5 8l4.5 4.5" />,
	chevronRight: <path d="M6 3.5L10.5 8 6 12.5" />,
	merge: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="8" r="1.6" /><path d="M4 5.1v5.8M4 5.1c0 2.4 3 2.9 6.4 2.9" /></>,
	commit: <><circle cx="8" cy="8" r="2.5" /><path d="M1.5 8h4M10.5 8h4" /></>,
	file: <><path d="M4 1.8h5l3 3v9.4H4z" /><path d="M9 1.8v3h3" /></>,
	comment: <path d="M2.5 3h11v8h-6l-3 2.5V11h-2z" />,
	clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
	play: <path d="M5 3.5l7 4.5-7 4.5z" />,
	eye: <><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
	search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
	plus: <path d="M8 3v10M3 8h10" />,
	sync: <><path d="M13 5.5A5.5 5.5 0 0 0 3.2 4.6M3 10.5a5.5 5.5 0 0 0 9.8.9" /><path d="M3 2v3h3M13 14v-3h-3" /></>,
	sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" /></>,
	moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
	monitor: <><rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.4" /><path d="M5.5 14h5M8 11v3" /></>,
	keyboard: <><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.5M6.5 7H7M9 7h.5M11.5 7h.5M5 9.5h6" /></>,
	bolt: <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />,
	grip: <><circle cx="6" cy="4" r=".9" fill="currentColor" /><circle cx="10" cy="4" r=".9" fill="currentColor" /><circle cx="6" cy="8" r=".9" fill="currentColor" /><circle cx="10" cy="8" r=".9" fill="currentColor" /><circle cx="6" cy="12" r=".9" fill="currentColor" /><circle cx="10" cy="12" r=".9" fill="currentColor" /></>,
	trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />,
	move: <path d="M8 2v12M2 8h12M8 2L6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" />,
	filter: <path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z" />,
	warning: <><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.5v.2" /></>,
	stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
	retry: <><path d="M13.5 8A5.5 5.5 0 1 1 11.6 3.8" /><path d="M12 1.5v3h-3" /></>,
	send: <path d="M2 8l12-5.5L10 14l-2.2-4.2z" />,
	undo: <><path d="M5 3L2 6l3 3" /><path d="M2 6h7a4.5 4.5 0 0 1 0 9H6" /></>,
	link: <path d="M7 9a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2L8.2 3.6M9 7a3 3 0 0 0-4.2 0L2.5 9.3a3 3 0 0 0 4.2 4.2l1.1-1.1" />,
	device: <><rect x="4" y="1.5" width="8" height="13" rx="1.5" /><path d="M7 12.5h2" /></>,
	tablet: <><rect x="2.5" y="1.5" width="11" height="13" rx="1.5" /><path d="M7 12.5h2" /></>,
	compare: <><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" /><path d="M8 2.5v11" /></>,
	menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
	info: <><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 5v.2" /></>,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
	return (
		<svg className={`i ${className ?? ''}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			{PATHS[name]}
		</svg>
	);
}
