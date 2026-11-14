import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProfileStore } from './profiles'

// README Authenticated SOCKS: active configs/backups may hold generated private
// listener credentials, so profile activation and recovery must keep them 0600.
describe('private runtime file permissions', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps active, backup and restored configs owner-only even after legacy 0644 files',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'mcxd-runtime-mode-'))
      const activeConfigPath = join(home, 'active.yaml')
      const backup = `${activeConfigPath}.bak`
      try {
        const profiles = createProfileStore({
          dir: join(home, 'profiles'),
          activeConfigPath,
        })
        const profile = await profiles.create({
          name: 'profile',
          content: 'proxies: []\n',
        })
        await writeFile(activeConfigPath, 'secret: previous-private-runtime\n')
        await writeFile(backup, 'legacy backup\n')
        await chmod(activeConfigPath, 0o644)
        await chmod(backup, 0o644)
        await profiles.setActive(profile.id)
        expect((await stat(activeConfigPath)).mode & 0o777).toBe(0o600)
        expect((await stat(backup)).mode & 0o777).toBe(0o600)
        expect(await readFile(backup, 'utf8')).toContain(
          'previous-private-runtime',
        )
        await chmod(activeConfigPath, 0o644)
        expect(await profiles.rollback()).toBe(true)
        expect((await stat(activeConfigPath)).mode & 0o777).toBe(0o600)
        expect(await readFile(activeConfigPath, 'utf8')).toContain(
          'previous-private-runtime',
        )
        await profiles.resetActive()
        expect((await stat(activeConfigPath)).mode & 0o777).toBe(0o600)
        expect((await stat(backup)).mode & 0o777).toBe(0o600)
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
  )
})
