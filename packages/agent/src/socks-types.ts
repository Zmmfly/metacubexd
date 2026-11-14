export interface SocksUserInput {
  id?: string
  username: string
  password?: string
  enabled: boolean
  proxy?: string
  provider?: string
}

export interface SocksConfigInput {
  enabled: boolean
  listen: string
  port: number
  users: SocksUserInput[]
}

export interface StoredSocksUser extends Omit<
  SocksUserInput,
  'id' | 'password'
> {
  id: string
  passwordHash: string
}

export interface StoredSocksConfig extends Omit<SocksConfigInput, 'users'> {
  users: StoredSocksUser[]
}

export interface PublicSocksUser extends Omit<StoredSocksUser, 'passwordHash'> {
  hasPassword: true
  error?: string
}

export interface PublicSocksConfig extends Omit<StoredSocksConfig, 'users'> {
  users: PublicSocksUser[]
}

export interface SocksSnapshot extends PublicSocksConfig {
  status: 'disabled' | 'listening' | 'error'
  error?: string
}
