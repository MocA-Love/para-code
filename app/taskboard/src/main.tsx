// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

// テーマは描画前に当てる（一瞬ほかの色で光らないように）
try {
	const stored = JSON.parse(localStorage.getItem('taskboard:theme') ?? '"dark"') as string;
	const resolved = stored === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : stored === 'light' ? 'light' : 'dark';
	document.documentElement.dataset.theme = resolved;
} catch { /* 既定のダークのまま */ }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
