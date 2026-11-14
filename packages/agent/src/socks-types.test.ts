import type {
  PublicSocksConfig,
  PublicSocksUser,
  SocksConfigInput,
  SocksSnapshot,
  SocksUserInput,
  StoredSocksConfig,
  StoredSocksUser,
} from './socks-types'
import { describe, expectTypeOf, it } from 'vitest'

// README Authenticated SOCKS: management snapshots never expose credential
// material; write inputs and persisted records have intentionally distinct types.
describe('authenticated SOCKS public types', () => {
  it('separates write-only passwords, private hashes, and public password presence', () => {
    expectTypeOf<SocksUserInput>()
      .toHaveProperty('password')
      .toEqualTypeOf<string | undefined>()
    expectTypeOf<StoredSocksUser>().not.toHaveProperty('password')
    expectTypeOf<StoredSocksUser>()
      .toHaveProperty('passwordHash')
      .toEqualTypeOf<string>()
    expectTypeOf<StoredSocksUser>().toHaveProperty('id').toEqualTypeOf<string>()
    expectTypeOf<PublicSocksUser>().not.toHaveProperty('password')
    expectTypeOf<PublicSocksUser>().not.toHaveProperty('passwordHash')
    expectTypeOf<PublicSocksUser>()
      .toHaveProperty('hasPassword')
      .toEqualTypeOf<true>()
    expectTypeOf<SocksConfigInput>()
      .toHaveProperty('users')
      .toEqualTypeOf<SocksUserInput[]>()
    expectTypeOf<StoredSocksConfig>()
      .toHaveProperty('users')
      .toEqualTypeOf<StoredSocksUser[]>()
    expectTypeOf<PublicSocksConfig>()
      .toHaveProperty('users')
      .toEqualTypeOf<PublicSocksUser[]>()
    expectTypeOf<SocksSnapshot>()
      .toHaveProperty('status')
      .toEqualTypeOf<'disabled' | 'listening' | 'error'>()
  })
})
