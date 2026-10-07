import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeUrl, HttpJsonSmsProvider, httpJsonConfigSchema } from '../src/integrations/sms/HttpJsonSmsProvider';
import { hmacSha256, encrypt } from '../src/utils/crypto';
import { InvalidCallbackSignatureError } from '../src/integrations/sms/SmsProvider';

/** A tiny fake upstream: records requests and answers according to the destination number. */
let server: http.Server;
let base: string;
const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/send') {
        if (body.to.endsWith('500')) return void res.writeHead(503).end('{}');
        if (body.to.endsWith('400')) return void res.writeHead(400).end(JSON.stringify({ error: { message: 'bad number' } }));
        return void res.end(JSON.stringify({ status: 'queued', data: { id: `up-${body.reference}` } }));
      }
      if (req.url?.startsWith('/status/')) return void res.end(JSON.stringify({ state: 'delivered' }));
      if (req.url === '/balance') return void res.end(JSON.stringify({ account: { units: 1234 } }));
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const config = () =>
  httpJsonConfigSchema.parse({
    sendUrl: `${base}/send`,
    statusUrl: `${base}/status/{{providerMessageId}}`,
    balanceUrl: `${base}/balance`,
    auth: { type: 'HEADER', name: 'X-API-Key' },
    bodyTemplate: '{"to":"{{to}}","from":"{{from}}","text":"{{message}}","reference":"{{reference}}","parts":"{{segments}}"}',
    response: { messageIdPath: 'data.id', successPath: 'status', successValues: ['queued'], errorMessagePath: 'error.message' },
    status: { statusPath: 'state', messageIdPath: 'id', delivered: ['delivered'], failed: ['failed'], expired: [] },
    balance: { path: 'account.units' },
    callback: { mode: 'HMAC_SHA256', headerName: 'x-signature' },
  });

const make = () =>
  new HttpJsonSmsProvider({
    key: 'acme-production',
    network: 'Acme',
    config: config(),
    secrets: { apiKeyEncrypted: encrypt('secret-key'), callbackSecretEncrypted: encrypt('callback-secret') },
    allowPrivate: true,
  });

const send = (to: string) => make().sendSms({ from: 'ACME', to, message: 'Hi "there"', encoding: 'GSM7', segments: 2, clientReference: 'ref-1' });

describe('HTTP JSON provider adapter', () => {
  it('renders the template safely, authenticates and reads the provider message id', async () => {
    const r = await send('+250788123456');
    expect(r).toMatchObject({ accepted: true, providerMessageId: 'up-ref-1' });
    const call = seen.find((s) => s.url === '/send')!;
    expect(call.headers['x-api-key']).toBe('secret-key');
    expect(call.body).toMatchObject({ to: '+250788123456', from: 'ACME', text: 'Hi "there"', reference: 'ref-1', parts: 2 });
  });

  it('classifies failures: 5xx retryable, 4xx final', async () => {
    expect(await send('+250788123500')).toMatchObject({ accepted: false, retryable: true, errorCode: 'HTTP_503' });
    expect(await send('+250788123400')).toMatchObject({ accepted: false, retryable: false, errorMessage: 'bad number' });
  });

  it('polls status, reads balance and never needs the secret in the config', async () => {
    expect(await make().getDeliveryStatus('abc')).toMatchObject({ state: 'DELIVERED', providerStatus: 'delivered' });
    expect((await make().getBalance()).available).toBe(1234);
    expect(JSON.stringify(config())).not.toContain('secret-key');
  });

  it('accepts only correctly signed callbacks', async () => {
    const body = JSON.stringify({ id: 'up-1', state: 'delivered' });
    const ok = await make().parseDeliveryCallback({ headers: { 'x-signature': hmacSha256('callback-secret', body) }, rawBody: body });
    expect(ok).toMatchObject([{ providerMessageId: 'up-1', state: 'DELIVERED' }]);
    await expect(make().parseDeliveryCallback({ headers: { 'x-signature': 'nope' }, rawBody: body })).rejects.toBeInstanceOf(InvalidCallbackSignatureError);
    await expect(make().parseDeliveryCallback({ headers: {}, rawBody: body })).rejects.toBeInstanceOf(InvalidCallbackSignatureError);
  });
});

describe('outbound URL safety', () => {
  it('refuses http, credentials in the URL and private or metadata addresses', async () => {
    await expect(assertSafeUrl('http://example.com/x', false)).rejects.toThrow(/https/);
    await expect(assertSafeUrl('https://user:pw@example.com/x', false)).rejects.toThrow(/credentials/);
    await expect(assertSafeUrl('https://127.0.0.1/x', false)).rejects.toThrow(/private/);
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data', false)).rejects.toThrow(/private/);
    await expect(assertSafeUrl('https://[::1]/x', false)).rejects.toThrow(/private/);
    await expect(assertSafeUrl('https://10.1.2.3/x', false)).rejects.toThrow(/private/);
  });

  it('is permissive only when explicitly allowed (local development)', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:9/x', true)).resolves.toBeInstanceOf(URL);
  });
});
