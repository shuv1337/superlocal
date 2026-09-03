import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInbox } from '../src/core'
import { InboxError, type Connection, type ProviderDefinition } from '../src/contracts'
import { createMicrosoftOAuthHost, type MicrosoftOAuthAttempt, type MicrosoftOAuthConfig } from '../server/microsoft-oauth'
import { createMicrosoftOAuthApi } from '../server/microsoft-oauth-api'
import { createMicrosoftCredentialRefresh, verifyMicrosoftCredentials } from '../server/credential-refresh'
import type { InboxProvider } from '../server/sdk/types'

const KEY = Buffer.alloc(32, 37).toString('base64')
const SECRET = 'synthetic-microsoft-secret-do-not-disclose'
const TID = '11111111-1111-1111-1111-111111111111'
const OID = '22222222-2222-2222-2222-222222222222'
const EMAIL = 'verified-outlook@example.test'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const tasks = cleanup.splice(0).reverse()
  for (const task of tasks) await task()
})

const microsoftOAuth: MicrosoftOAuthConfig = {
  clientId: '11111111-2222-3333-4444-555555555555',
  clientSecret: `${SECRET}-microsoft-client`,
  redirectUri: 'https://inbox.example.test/v1/oauth/outlook/callback',
  tenant: 'common',
  scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'],
}

const discovery = {
  issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
  authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  userinfo_endpoint: 'https://graph.microsoft.com/oidc/userinfo',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
  id_token_signing_alg_values_supported: ['RS256'],
  code_challenge_methods_supported: ['S256'],
  subject_types_supported: ['pairwise'],
}

function outlookProvider(): ProviderDefinition {
  return {
    id: 'outlook', name: 'Outlook', connection: 'oauth',
    create(credentials) {
      if (typeof credentials.accessToken !== 'string' || !credentials.accessToken) {
        throw new InboxError('INVALID_CREDENTIALS', 'Outlook requires an access token.')
      }
      const accountId = String(credentials.accountId)
      return {
        type: 'outlook', accountId,
        capabilities: {
          sync: true, incrementalSync: true, deltaSync: true, send: true, reply: true,
          threads: true, nativeThreads: true, folders: true, createFolders: true,
          labels: true, archive: true, trash: true, permanentDelete: false, markRead: true,
          markUnread: true, star: true, attachments: true, attachmentDownload: true,
          search: true, drafts: false, scheduledSend: false, snooze: false,
          readReceipts: false, pushNotifications: false,
        },
        async getAccount() {
          return { id: accountId, email: EMAIL, name: 'Outlook', provider: 'outlook', color: '#64748b', syncStatus: 'connected', unreadCount: 0 }
        },
        async disconnect() {},
      } as InboxProvider
    },
  }
}

async function fixture(options: { oauth?: MicrosoftOAuthConfig } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'outlook-oauth-'))
  const database = join(directory, 'mail.sqlite')
  const clock = { value: Date.now() }
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const oauth = options.oauth ?? microsoftOAuth
  const microsoft = {
    codes: new Map<string, {
      subject: string; oid: string; tid: string; nonce: string; challenge: string; email: string
      claims?: Record<string, unknown>; refreshToken?: string | null; forged?: boolean; profileId?: string
    }>(),
    requests: [] as Array<{ url: string; method: string }>,
    issued: [] as Array<{ accessToken: string; idToken: string; refreshToken?: string }>,
    profiles: new Map<string, { id: string; email: string }>(),
  }
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    const body = await request.text()
    microsoft.requests.push({ url: request.url, method: request.method })
    if (request.url === 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration' && request.method === 'GET') {
      return Response.json(discovery)
    }
    if (request.url === discovery.jwks_uri && request.method === 'GET') {
      return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'pilot-rs256', alg: 'RS256', use: 'sig' }] })
    }
    if (request.url.startsWith('https://graph.microsoft.com/v1.0/me') && request.method === 'GET') {
      const access = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '')
      const profile = microsoft.profiles.get(access)
      if (!profile) return Response.json({ error: 'invalid_token' }, { status: 401 })
      return Response.json({ id: profile.id, mail: profile.email, userPrincipalName: profile.email, displayName: 'Outlook' })
    }
    if (request.url !== discovery.token_endpoint || request.method !== 'POST') {
      throw new Error(`Live network is forbidden: unexpected Microsoft request ${request.method} ${request.url}`)
    }
    const form = new URLSearchParams(body)
    const code = form.get('code') ?? ''
    const grant = microsoft.codes.get(code)
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
    const authenticated = form.get('client_id') === oauth.clientId && form.get('client_secret') === oauth.clientSecret
    if (!grant || grant.challenge !== challenge || form.get('grant_type') !== 'authorization_code'
      || form.get('redirect_uri') !== oauth.redirectUri || !authenticated) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    microsoft.codes.delete(code)
    const claims = {
      iss: `https://login.microsoftonline.com/${grant.tid}/v2.0`, sub: grant.subject, aud: oauth.clientId,
      oid: grant.oid, tid: grant.tid, email: grant.email, preferred_username: grant.email, nonce: grant.nonce,
      iat: Math.floor(clock.value / 1000), exp: Math.floor(clock.value / 1000) + 3600, ...grant.claims,
    }
    const unsigned = [
      { alg: 'RS256', kid: 'pilot-rs256', typ: 'JWT' }, claims,
    ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey)
    if (grant.forged) signature[0] = signature[0]! ^ 1
    const idToken = `${unsigned}.${signature.toString('base64url')}`
    const accessToken = `${SECRET}-microsoft-${code}`
    const refreshToken = grant.refreshToken === null ? undefined : grant.refreshToken ?? `${SECRET}-refresh-outlook`
    microsoft.profiles.set(accessToken, { id: grant.profileId ?? grant.oid, email: grant.email })
    microsoft.issued.push({ accessToken, idToken, refreshToken })
    return Response.json({
      access_token: accessToken, id_token: idToken, token_type: 'Bearer', expires_in: 3600,
      scope: (oauth.scopes ?? []).join(' '),
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    })
  }) as typeof fetch
  const inbox = createInbox({
    database, encryptionKey: KEY, providers: [outlookProvider()], now: () => clock.value, fetch: fetchImpl,
  })
  const hostDatabase = new Database(database)
  const host = createMicrosoftOAuthHost({
    inbox, database: hostDatabase, encryptionKey: KEY, config: oauth, now: () => clock.value, fetch: fetchImpl,
  })
  const authenticate = async (request: Request) => {
    const token = request.headers.get('authorization')
    return token === 'Bearer alice' ? { id: 'alice' } : token === 'Bearer bob' ? { id: 'bob' } : null
  }
  const api = new Hono().route('/', createMicrosoftOAuthApi({
    oauth: () => host, authenticate, allowedOrigins: ['https://app.example.test'],
  }))
  cleanup.push(async () => {
    hostDatabase.close()
    await inbox.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { inbox, api, host, clock, microsoft, oauth, fetchImpl }
}

async function authorize(api: Hono, owner = 'alice') {
  const started = await api.request('https://inbox.example.test/v1/connections/outlook/start', {
    method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: '{}',
  })
  expect(started.status).toBe(200)
  const attempt = await started.json() as MicrosoftOAuthAttempt
  const handoff = await api.request(attempt.authorizeUrl!)
  expect(handoff.status).toBe(302)
  return { attempt, handoff, authorization: new URL(handoff.headers.get('location')!), cookie: handoff.headers.get('set-cookie')!.split(';')[0]! }
}

describe('Microsoft Graph OAuth host', () => {
  test('starts with host auth, uses a one-use cookie handoff and real PKCE/JWKS validation, and returns only a connection', async () => {
    const h = await fixture()
    const { attempt, handoff, authorization, cookie } = await authorize(h.api)
    expect(attempt).toMatchObject({ providerId: 'outlook', status: 'pending', connectionId: null })
    expect(handoff.headers.get('cache-control')).toBe('no-store')
    expect(cookie.split('=')[0]).toBe(`inbox_outlook_oauth_${attempt.id}`)
    expect(authorization.origin).toBe('https://login.microsoftonline.com')
    expect(authorization.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(authorization.searchParams.get('client_id')).toBe(microsoftOAuth.clientId)
    expect(authorization.searchParams.get('redirect_uri')).toBe(microsoftOAuth.redirectUri)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('scope')?.split(' ').sort()).toEqual([...(microsoftOAuth.scopes ?? [])].sort())
    expect(authorization.href).not.toContain(microsoftOAuth.clientSecret)
    h.microsoft.codes.set('outlook-first-code', {
      subject: 'pairwise-subject', oid: OID, tid: TID, email: EMAIL,
      nonce: authorization.searchParams.get('nonce')!, challenge: authorization.searchParams.get('code_challenge')!,
    })
    const callback = new URL(microsoftOAuth.redirectUri)
    callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'outlook-first-code' }).toString()
    const response = await h.api.request(callback.href, { headers: { cookie } })
    expect(response.status).toBe(200)
    const connection = await response.json() as Connection
    expect(connection).toMatchObject({
      providerId: 'outlook',
      identity: { issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: OID, registrationId: microsoftOAuth.clientId },
    })
    expect(JSON.stringify(connection)).not.toContain(SECRET)
    expect(h.microsoft.requests.some(request => request.url === discovery.jwks_uri)).toBe(true)
    expect(h.microsoft.requests.some(request => request.url.startsWith('https://graph.microsoft.com/v1.0/me'))).toBe(true)
    expect((await h.inbox.connections('alice')).map(item => item.id)).toEqual([connection.id])
    expect(await h.inbox.connections('bob')).toEqual([])
  })

  test('forged signatures, wrong nonce, other issuer, and Graph object-id mismatch never create a connection', async () => {
    const h = await fixture()
    const invalidTokens = [
      { name: 'forged-signature', forged: true },
      { name: 'wrong-nonce', claims: { nonce: 'different-browser-nonce' } },
      { name: 'other-issuer', claims: { iss: 'https://attacker.example.test' } },
      { name: 'oid-mismatch', profileId: '33333333-3333-3333-3333-333333333333' },
    ]
    for (const invalidToken of invalidTokens) {
      const { authorization, cookie } = await authorize(h.api)
      h.microsoft.codes.set(invalidToken.name, {
        subject: 'untrusted-subject', oid: OID, tid: TID, email: EMAIL,
        nonce: authorization.searchParams.get('nonce')!, challenge: authorization.searchParams.get('code_challenge')!,
        claims: invalidToken.claims, forged: invalidToken.forged, profileId: invalidToken.profileId,
      })
      const callback = new URL(microsoftOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: invalidToken.name }).toString()
      const response = await h.api.request(callback.href, { headers: { cookie } })
      expect(response.status).toBe(400)
      expect(JSON.parse(await response.text())).toMatchObject({ code: 'OAUTH_FAILED' })
      expect(await h.inbox.connections('alice')).toEqual([])
    }
  })

  test('same verified Microsoft identity reauthorization preserves the connection', async () => {
    const h = await fixture()
    let original: Connection | undefined
    for (let index = 0; index < 2; index++) {
      const started = await h.api.request('https://inbox.example.test/v1/connections/outlook/start', {
        method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
        body: JSON.stringify(index === 1 ? { connectionId: original!.id } : {}),
      })
      expect(started.status).toBe(200)
      const attempt = await started.json() as MicrosoftOAuthAttempt
      const handoff = await h.api.request(attempt.authorizeUrl!)
      const authorization = new URL(handoff.headers.get('location')!)
      const code = `reauth-${index}`
      h.microsoft.codes.set(code, {
        subject: 'pairwise-subject', oid: OID, tid: TID, email: EMAIL,
        nonce: authorization.searchParams.get('nonce')!, challenge: authorization.searchParams.get('code_challenge')!,
        ...(index ? { refreshToken: null } : {}),
      })
      const callback = new URL(microsoftOAuth.redirectUri)
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code }).toString()
      const response = await h.api.request(callback.href, { headers: { cookie: handoff.headers.get('set-cookie')!.split(';')[0]! } })
      expect(response.status).toBe(200)
      const connection = await response.json() as Connection
      if (original) {
        expect(connection.id).toBe(original.id)
        expect(connection.sourceIds).toEqual(original.sourceIds)
        expect(connection.generation).toBeGreaterThan(original.generation)
      }
      original = connection
    }
    expect(await h.inbox.connections('alice')).toHaveLength(1)
  })

  test('host refresh injects the Microsoft client registration and tenant from the verified identity', async () => {
    const exchanges: string[] = []
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      exchanges.push(body.get('client_id') ?? '')
      expect(body.get('client_secret')).toBe(microsoftOAuth.clientSecret)
      expect(_url.toString()).toBe(`https://login.microsoftonline.com/${TID}/oauth2/v2.0/token`)
      return Response.json({ access_token: `${SECRET}-renewed`, token_type: 'Bearer', expires_in: 3600 })
    }) as typeof fetch
    const directory = await mkdtemp(join(tmpdir(), 'outlook-refresh-'))
    const inbox = createInbox({
      database: join(directory, 'mail.sqlite'), encryptionKey: KEY, providers: [outlookProvider()],
    })
    cleanup.push(async () => { await inbox.close(); await rm(directory, { recursive: true, force: true }) })
    const connection = await inbox.createConnection('alice', { providerId: 'outlook', credentials: {
      accessToken: SECRET, refreshToken: `${SECRET}-refresh`,
    } }, { issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: OID, registrationId: microsoftOAuth.clientId })
    const refreshed = await createMicrosoftCredentialRefresh(microsoftOAuth, fetcher)!({ refreshToken: `${SECRET}-refresh` },
      new AbortController().signal, {
        owner: 'alice', connection, credentials: { refreshToken: `${SECRET}-refresh` },
        reason: 'expired', signal: new AbortController().signal,
      })
    expect(exchanges).toEqual([microsoftOAuth.clientId])
    expect(refreshed).toMatchObject({ accessToken: `${SECRET}-renewed` })
  })

  test('verifyMicrosoftCredentials accepts a Graph profile that matches the stored object id', async () => {
    const fetcher = (async (input: string | URL | Request) => {
      expect(String(input)).toContain('https://graph.microsoft.com/v1.0/me')
      return Response.json({ id: OID, mail: EMAIL, userPrincipalName: EMAIL })
    }) as typeof fetch
    const directory = await mkdtemp(join(tmpdir(), 'outlook-verify-'))
    const inbox = createInbox({ database: join(directory, 'mail.sqlite'), encryptionKey: KEY, providers: [outlookProvider()] })
    cleanup.push(async () => { await inbox.close(); await rm(directory, { recursive: true, force: true }) })
    const connection = await inbox.createConnection('alice', { providerId: 'outlook', credentials: { accessToken: SECRET } },
      { issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: OID, registrationId: microsoftOAuth.clientId })
    expect(await verifyMicrosoftCredentials({
      owner: 'alice', connection, credentials: { accessToken: SECRET }, reason: 'update', signal: new AbortController().signal,
    }, microsoftOAuth, fetcher)).toBe(true)
  })
})
