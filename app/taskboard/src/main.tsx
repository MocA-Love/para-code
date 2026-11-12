// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { THEME_BACKGROUND } from './hooks.js';
import './styles.css';

// テーマは描画前に当てる（一瞬ほかの色で光らないように）
try {
	const stored = JSON.parse(localStorage.getItem('taskboard:theme') ?? '"dark"') as string;
	const resolved = stored === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : stored === 'light' ? 'light' : 'dark';
	document.documentElement.dataset.theme = resolved;
	// Para Code はこの色を窓の背景色にする（読み込みの途中で既定のダークの色を知らせないように、描画前に当てる）
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BACKGROUND[resolved]);
} catch { /* 既定のダークのまま */ }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
