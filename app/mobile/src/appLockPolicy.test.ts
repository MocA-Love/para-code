// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { foregroundAction, isAppLocked, lockedContentProps, lockedModalVisible, REAUTH_GRACE_MS, shouldRelock } from './appLockPolicy.js';

const MOBILE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return sourceFiles(path);
		}
		return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
	});
}

function tsxFiles(dir: string): string[] {
	return sourceFiles(dir).filter(path => path.endsWith('.tsx'));
}

describe('app lock policy', () => {
	it('re-locks only after the grace period has passed since leaving while unlocked', () => {
		const left = 1_000_000;
		expect([
			shouldRelock(undefined, left + REAUTH_GRACE_MS * 2),
			shouldRelock(left, left + REAUTH_GRACE_MS),
			shouldRelock(left, left + REAUTH_GRACE_MS + 1),
		]).toEqual([false, false, true]);
	});

	it('decides what to do when the app comes back to the foreground', () => {
		const left = 1_000_000;
		const late = left + REAUTH_GRACE_MS + 1;
		expect([
			foregroundAction('unlocked', left, left + 60_000),
			foregroundAction('unlocked', left, late),
			foregroundAction('unlocked', undefined, late),
			foregroundAction('locked', undefined, late),
			foregroundAction('authenticating', undefined, late),
		]).toEqual(['none', 'authenticate', 'none', 'authenticate', 'watchStuck']);
	});

	it('treats every state but unlocked as locked', () => {
		expect([isAppLocked('locked'), isAppLocked('authenticating'), isAppLocked('unlocked')]).toEqual([true, true, false]);
	});

	it('hides modals while locked', () => {
		expect([
			lockedModalVisible(true, false),
			lockedModalVisible(true, true),
			lockedModalVisible(false, false),
			lockedModalVisible(false, true),
		]).toEqual([true, false, false, false]);
	});

	it('keeps the content mounted and only switches its props', () => {
		expect([lockedContentProps(true), lockedContentProps(false)]).toEqual([
			{ pointerEvents: 'none', accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' },
			{ pointerEvents: 'auto', accessibilityElementsHidden: false, importantForAccessibility: 'auto' },
		]);
	});

	// RN の Modal はネイティブで最前面に出るので、ロック画面を重ねても覆えない。置いた数だけ visible を落としているか。
	it('every React Native Modal hides its visible while locked', () => {
		const offenders = [...tsxFiles(join(MOBILE_ROOT, 'src')), ...tsxFiles(join(MOBILE_ROOT, 'app'))]
			.map(path => {
				const source = readFileSync(path, 'utf8');
				return { path: relative(MOBILE_ROOT, path), modals: source.match(/<Modal\b/g)?.length ?? 0, guarded: source.match(/\blockedModalVisible\(/g)?.length ?? 0 };
			})
			.filter(file => file.modals !== file.guarded);
		expect(offenders).toEqual([]);
	});

	// Alert もネイティブで最前面に出て、ロック中に押せてしまう。必ず paraAlert を通す。
	it('nothing calls Alert.alert or Alert.prompt directly', () => {
		const offenders = [...sourceFiles(join(MOBILE_ROOT, 'src')), ...sourceFiles(join(MOBILE_ROOT, 'app'))]
			.filter(path => !path.endsWith('.test.ts') && !path.endsWith('paraAlert.ts') && !path.endsWith('paraAlertCore.ts'))
			.filter(path => /\bAlert\.(?:alert|prompt)\(/.test(readFileSync(path, 'utf8')))
			.map(path => relative(MOBILE_ROOT, path));
		expect(offenders).toEqual([]);
	});
});
