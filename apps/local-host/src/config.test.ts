import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLocalConfig, LocalConfigurationError } from './config'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const tasks = cleanup.splice(0).reverse()
  for (const task of tasks) await task()
})

const instanceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const gmail = {
  enabled: false,
  oauth: {
    clientId: { env: 'SUPERLOCAL_GOOGLE_CLIENT_ID' },
    clientSecret: { env: 'SUPERLOCAL_GOOGLE_CLIENT_SECRET' },
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'],
  },
}

async function configFile(providers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'superlocal-config-'))
  cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const path = join(directory, 'superlocal.local.json')
  await writeFile(path, `${JSON.stringify({
    version: 1, instanceId, mode: 'mock', dataDir: null,
    web: { port: 5178, origin: null, allowedOrigins: ['https://super.local'] },
    backend: { port: 8790 }, auth: { method: 'loopback', sessionHours: 12 },
    allowProviderWrites: { mock: true, real: true },
    providers, ...extra,
  }, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

describe('local host configuration', () => {
  test('existing files without outlook still load with outlook disabled', async () => {
    const path = await configFile({
      mock: { enabled: true }, gmail, inbound: { enabled: false },
    })
    const config = loadLocalConfig({ configPath: path, environment: {} })
    expect(config.providers.outlook).toMatchObject({
      enabled: false, tenant: 'common',
      oauth: { clientId: { env: 'SUPERLOCAL_MICROSOFT_CLIENT_ID' }, clientSecret: { env: 'SUPERLOCAL_MICROSOFT_CLIENT_SECRET' } },
    })
    expect(config.providers.outlook.oauth.scopes).toContain('Mail.ReadWrite')
    expect(config.providers.gmail.enabled).toBe(false)
  })

  test('new defaults include disabled outlook and accept an enabled Entra tenant', async () => {
    const path = await configFile({
      mock: { enabled: true }, gmail, inbound: { enabled: false },
      outlook: {
        enabled: true, tenant: 'organizations',
        oauth: {
          clientId: { env: 'SUPERLOCAL_MICROSOFT_CLIENT_ID' },
          clientSecret: { env: 'SUPERLOCAL_MICROSOFT_CLIENT_SECRET' },
          scopes: ['openid', 'offline_access', 'User.Read', 'Mail.Read'],
        },
      },
    })
    const config = loadLocalConfig({ configPath: path, environment: { SUPERLOCAL_MICROSOFT_TENANT: '11111111-1111-1111-1111-111111111111' } })
    expect(config.providers.outlook.enabled).toBe(true)
    expect(config.providers.outlook.tenant).toBe('11111111-1111-1111-1111-111111111111')
    expect(config.providers.outlook.oauth.scopes).toEqual(['openid', 'offline_access', 'User.Read', 'Mail.Read'])
  })

  test('rejects an invalid Microsoft tenant', async () => {
    const path = await configFile({
      mock: { enabled: true }, gmail, inbound: { enabled: false },
      outlook: {
        enabled: false, tenant: 'not-a-tenant',
        oauth: {
          clientId: { env: 'SUPERLOCAL_MICROSOFT_CLIENT_ID' },
          clientSecret: { env: 'SUPERLOCAL_MICROSOFT_CLIENT_SECRET' },
          scopes: ['openid', 'offline_access', 'User.Read', 'Mail.Read'],
        },
      },
    })
    expect(() => loadLocalConfig({ configPath: path, environment: {} })).toThrow(LocalConfigurationError)
  })
})
