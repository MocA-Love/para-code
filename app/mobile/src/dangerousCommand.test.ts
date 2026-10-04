// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { dangerousCommandLabels } from './dangerousCommand.js';

describe('dangerousCommandLabels', () => {
	it('returns nothing for ordinary commands', () => {
		expect(dangerousCommandLabels(undefined)).toEqual([]);
		expect(dangerousCommandLabels('')).toEqual([]);
		expect(dangerousCommandLabels('pnpm test --filter relay')).toEqual([]);
		expect(dangerousCommandLabels('rm tmp.txt')).toEqual([]);
		expect(dangerousCommandLabels('git push origin main')).toEqual([]);
		expect(dangerousCommandLabels('git push --follow-tags')).toEqual([]);
		expect(dangerousCommandLabels('git reset --soft HEAD~1')).toEqual([]);
		expect(dangerousCommandLabels('git clean -n')).toEqual([]);
		expect(dangerousCommandLabels('chmod +x run.sh')).toEqual([]);
	});

	it('detects recursive deletion', () => {
		expect(dangerousCommandLabels('rm -rf node_modules && pnpm install')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('rm -r build')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('rm -fr dist')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('rm -f -R out')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('rm --recursive out')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('cd app; rm -rf .cache')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('git clean -fd')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('git clean -xdf')).toEqual(['削除を含む']);
	});

	it('detects deletion inside a quoted shell -c script', () => {
		expect(dangerousCommandLabels('docker exec $C sh -c "rm -rf /srv/render/.staging"')).toEqual(['削除を含む']);
		expect(dangerousCommandLabels("bash -c 'rm -r build'")).toEqual(['削除を含む']);
		expect(dangerousCommandLabels('echo "rm" -r')).toEqual([]);
	});

	it('does not mistake look-alike flags for rm -r', () => {
		expect(dangerousCommandLabels('docker run --rm -it node')).toEqual([]);
		expect(dangerousCommandLabels('rmdir -p a/b')).toEqual([]);
		expect(dangerousCommandLabels('npm run rm-cache')).toEqual([]);
	});

	it('detects force push in every spelling', () => {
		expect(dangerousCommandLabels('git push --force')).toEqual(['強制 push']);
		expect(dangerousCommandLabels('git push -f origin feat')).toEqual(['強制 push']);
		expect(dangerousCommandLabels('git push origin feat --force-with-lease')).toEqual(['強制 push']);
		expect(dangerousCommandLabels('git push -uf origin feat')).toEqual(['強制 push']);
	});

	it('detects history rewrites, sudo and recursive permission changes', () => {
		expect(dangerousCommandLabels('git reset --hard origin/main')).toEqual(['履歴を書き換える']);
		expect(dangerousCommandLabels('sudo apt install jq')).toEqual(['管理者権限']);
		expect(dangerousCommandLabels('chmod -R 777 .')).toEqual(['権限を一括変更']);
		expect(dangerousCommandLabels('chown -R me:staff dir')).toEqual(['権限を一括変更']);
	});

	it('detects database drops and raw disk writes', () => {
		expect(dangerousCommandLabels('psql -c "DROP TABLE users"')).toEqual(['DB を削除']);
		expect(dangerousCommandLabels('drop database app;')).toEqual(['DB を削除']);
		expect(dangerousCommandLabels('mkfs.ext4 /dev/sdb1')).toEqual(['ディスクを上書き']);
		expect(dangerousCommandLabels('dd if=image.iso of=/dev/disk2')).toEqual(['ディスクを上書き']);
		expect(dangerousCommandLabels('echo x > /dev/sda')).toEqual(['ディスクを上書き']);
	});

	it('ignores writes to the null device and standard streams', () => {
		expect(dangerousCommandLabels('make 2>/dev/null')).toEqual([]);
		expect(dangerousCommandLabels('echo hi > /dev/stderr')).toEqual([]);
	});

	it('lists each label once in a fixed order', () => {
		expect(dangerousCommandLabels('sudo rm -rf /tmp/a && rm -r /tmp/b && git push -f')).toEqual(['削除を含む', '強制 push', '管理者権限']);
	});
});
