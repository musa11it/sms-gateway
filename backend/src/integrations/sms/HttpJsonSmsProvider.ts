import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { z } from 'zod';
import { decrypt } from '../../utils/crypto';
import { hmacSha256, safeEqual } from '../../utils/crypto';
import {
  InvalidCallbackSignatureError,
  type CallbackInput,
  type DeliveryState,
  type DeliveryStatus,
  type ProviderBalance,
  type PurchaseCapacityRequest,
  type PurchaseCapacityResult,
  type RegisterSenderIdRequest,
  type RegisterSenderIdResult,
  type SendSmsRequest,
  type SendSmsResult,
  type SmsProviderAdapter,
} from './SmsProvider';

/**
 * A provider integration described entirely by configuration: any upstream that accepts a JSON
 * (or form-like) POST with an API key can be connected from the admin UI, without a code change.
 *
 * Safety: HTTPS only (HTTP allowed for local testing outside production), no redirects, and the
 * destination is resolved and checked against private/loopback/metadata ranges before each call.
 */

const path = z.string().trim().min(1).max(200).regex(/^[\w.\-[\]]+$/, 'Use a dotted path such as data.id');
const statusValues = z.array(z.string().trim().min(1).max(60)).max(30);

export const httpJsonConfigSchema = z
  .object({
    sendUrl: z.string().trim().url().max(500),
    statusUrl: z.string().trim().url().max(500).optional().nullable(),
    balanceUrl: z.string().trim().url().max(500).optional().nullable(),
    auth: z
      .object({
        type: z.enum(['NONE', 'BEARER', 'HEADER', 'BASIC']),
        /** HEADER: the header that carries the key (e.g. "apiKey", "X-API-Key"). BASIC: the user name. */
        name: z.string().trim().max(80).regex(/^[A-Za-z0-9\-_]*$/).optional().nullable(),
      })
      .default({ type: 'BEARER' }),
    headers: z.record(z.string().regex(/^[A-Za-z0-9\-_]+$/).max(60), z.string().max(300)).default({}),
    /** JSON text. String values may contain {{to}} {{from}} {{message}} {{reference}} {{callbackUrl}} {{segments}} {{encoding}}. */
    bodyTemplate: z.string().trim().min(2).max(4000).refine((v) => {
      try {
        const parsed = JSON.parse(v);
        return typeof parsed === 'object' && parsed !== null;
      } catch {
        return false;
      }
    }, 'Must be a valid JSON object'),
    response: z.object({
      /** Where the provider's own message id is in the response body. */
      messageIdPath: path,
      /** Optional: a field that tells success from failure, and the values that mean success. */
      successPath: path.optional().nullable(),
      successValues: statusValues.default([]),
      errorMessagePath: path.optional().nullable(),
    }),
    status: z
      .object({
        /** Where the delivery state is in the status response / callback body. */
        statusPath: path,
        messageIdPath: path.optional().nullable(),
        errorMessagePath: path.optional().nullable(),
        delivered: statusValues.default(['DELIVERED']),
        failed: statusValues.default(['FAILED', 'REJECTED', 'UNDELIVERED']),
        expired: statusValues.default(['EXPIRED']),
      })
      .optional()
      .nullable(),
    balance: z.object({ path }).optional().nullable(),
    callback: z
      .object({
        /** HMAC_SHA256: hex HMAC of the raw body in `headerName`. SHARED_HEADER: `headerName` must equal the secret. */
        mode: z.enum(['HMAC_SHA256', 'SHARED_HEADER']),
        headerName: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9\-_]+$/),
      })
      .optional()
      .nullable(),
    currency: z.string().trim().length(3).toUpperCase().default('RWF'),
  })
  .strict();

export type HttpJsonConfig = z.infer<typeof httpJsonConfigSchema>;

/** Secrets kept next to the config, encrypted. They are accepted in plain text on write and never returned. */
export interface HttpJsonSecrets {
  apiKeyEncrypted?: string | null;
  callbackSecretEncrypted?: string | null;
}

const blocked = new net.BlockList();
for (const [net4, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(net4, prefix, 'ipv4');
}
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(net6, prefix, 'ipv6');

function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1] : address;
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Throws unless the URL is safe to call from the server. `allowPrivate` is for local development only. */
export async function assertSafeUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new Error('Only https:// URLs are allowed');
  if (url.username || url.password) throw new Error('Do not put credentials in the URL');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isBlockedAddress)) throw new Error('This address points to a private or internal network');
  return url;
}

function getPath(obj: unknown, p: string): unknown {
  return p
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined), obj);
}

type Vars = Record<string, string | number>;

function renderString(s: string, vars: Vars): string | number {
  const whole = /^\{\{(\w+)\}\}$/.exec(s);
  if (whole && typeof vars[whole[1]] === 'number') return vars[whole[1]];
  return s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k] ?? ''));
}

function renderJson(value: unknown, vars: Vars): unknown {
  if (typeof value === 'string') return renderString(value, vars);
  if (Array.isArray(value)) return value.map((v) => renderJson(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderJson(v, vars)]));
  return value;
}

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export interface HttpJsonOptions {
  key: string;
  network: string;
  config: HttpJsonConfig;
  secrets: HttpJsonSecrets;
  /** Local development only: permits http:// and private addresses. */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

export class HttpJsonSmsProvider implements SmsProviderAdapter {
  readonly isSimulation = false;
  readonly key: string;
  readonly network: string;
  private readonly cfg: HttpJsonConfig;

  constructor(private readonly opts: HttpJsonOptions) {
    this.key = opts.key;
    this.network = opts.network;
    this.cfg = opts.config;
  }

  private apiKey(): string | null {
    return this.opts.secrets.apiKeyEncrypted ? decrypt(this.opts.secrets.apiKeyEncrypted) : null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', ...this.cfg.headers };
    const key = this.apiKey();
    if (key) {
      if (this.cfg.auth.type === 'BEARER') h.authorization = `Bearer ${key}`;
      else if (this.cfg.auth.type === 'HEADER' && this.cfg.auth.name) h[this.cfg.auth.name] = key;
      else if (this.cfg.auth.type === 'BASIC') h.authorization = `Basic ${Buffer.from(`${this.cfg.auth.name ?? ''}:${key}`).toString('base64')}`;
    }
    return h;
  }

  private async call(method: 'GET' | 'POST', rawUrl: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const url = await assertSafeUrl(rawUrl, !!this.opts.allowPrivate);
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const raw = await res.text();
    let json: unknown = raw;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      /* keep the raw text; the path lookups will simply find nothing */
    }
    return { status: res.status, json };
  }

  async sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
    const vars: Vars = {
      to: req.to,
      from: req.from,
      message: req.message,
      reference: req.clientReference,
      callbackUrl: req.callbackUrl ?? '',
      segments: req.segments,
      encoding: req.encoding,
    };
    const body = renderJson(JSON.parse(this.cfg.bodyTemplate), vars);
    let result;
    try {
      result = await this.call('POST', this.cfg.sendUrl, body);
    } catch (err) {
      // Network failure, timeout or a blocked address: worth retrying unless the address itself is refused.
      const msg = (err as Error).message;
      const refused = /private or internal|https:\/\/|valid URL|credentials in the URL/.test(msg);
      return { accepted: false, errorCode: refused ? 'PROVIDER_URL_REFUSED' : 'PROVIDER_UNREACHABLE', errorMessage: msg, retryable: !refused };
    }
    const { status, json } = result;
    const r = this.cfg.response;
    const errMsg = (r.errorMessagePath && text(getPath(json, r.errorMessagePath))) || `Provider returned HTTP ${status}`;
    if (status === 429 || status >= 500) return { accepted: false, errorCode: `HTTP_${status}`, errorMessage: errMsg, retryable: true, raw: json };
    if (status < 200 || status >= 300) return { accepted: false, errorCode: `HTTP_${status}`, errorMessage: errMsg, retryable: false, raw: json };
    if (r.successPath && r.successValues.length) {
      const got = text(getPath(json, r.successPath));
      if (!r.successValues.some((v) => v.toLowerCase() === got.toLowerCase())) {
        return { accepted: false, errorCode: 'PROVIDER_REJECTED', errorMessage: errMsg === `Provider returned HTTP ${status}` ? `Provider answered "${got}"` : errMsg, retryable: false, raw: json };
      }
    }
    const providerMessageId = text(getPath(json, r.messageIdPath));
    if (!providerMessageId) return { accepted: false, errorCode: 'NO_MESSAGE_ID', errorMessage: 'The provider response did not contain a message id', retryable: false, raw: json };
    return { accepted: true, providerMessageId, providerStatus: 'ACCEPTED', raw: json };
  }

  private mapState(value: string): DeliveryState | null {
    const s = this.cfg.status;
    if (!s) return null;
    const has = (list: string[]) => list.some((v) => v.toLowerCase() === value.toLowerCase());
    if (has(s.delivered)) return 'DELIVERED';
    if (has(s.failed)) return 'FAILED';
    if (has(s.expired)) return 'EXPIRED';
    return null;
  }

  async getDeliveryStatus(providerMessageId: string): Promise<DeliveryStatus> {
    const s = this.cfg.status;
    // Without a status endpoint the provider can only tell us through callbacks; keep the message in flight.
    if (!s || !this.cfg.statusUrl) return { providerMessageId, state: 'SENT', providerStatus: 'UNKNOWN', occurredAt: new Date() };
    const { status, json } = await this.call('GET', this.cfg.statusUrl.replace(/\{\{providerMessageId\}\}/g, encodeURIComponent(providerMessageId)));
    if (status < 200 || status >= 300) throw new Error(`Status check returned HTTP ${status}`);
    const providerStatus = text(getPath(json, s.statusPath));
    const state = this.mapState(providerStatus);
    if (!state) return { providerMessageId, state: 'SENT', providerStatus: providerStatus || 'UNKNOWN', occurredAt: new Date(), raw: json };
    return {
      providerMessageId,
      state,
      providerStatus,
      errorMessage: (s.errorMessagePath && text(getPath(json, s.errorMessagePath))) || undefined,
      occurredAt: new Date(),
      raw: json,
    };
  }

  async parseDeliveryCallback(input: CallbackInput): Promise<DeliveryStatus[]> {
    const cb = this.cfg.callback;
    const s = this.cfg.status;
    const secret = this.opts.secrets.callbackSecretEncrypted ? decrypt(this.opts.secrets.callbackSecretEncrypted) : null;
    // A callback endpoint with no verification would let anyone mark messages delivered.
    if (!cb || !s || !secret) throw new InvalidCallbackSignatureError();
    const header = input.headers[cb.headerName.toLowerCase()];
    const supplied = Array.isArray(header) ? header[0] : header;
    const ok = !!supplied && (cb.mode === 'HMAC_SHA256' ? safeEqual(hmacSha256(secret, input.rawBody), supplied.trim().toLowerCase()) : safeEqual(secret, supplied.trim()));
    if (!ok) throw new InvalidCallbackSignatureError();

    const body = JSON.parse(input.rawBody) as unknown;
    const items = Array.isArray(body) ? body : [body];
    const out: DeliveryStatus[] = [];
    for (const item of items) {
      const providerMessageId = text(getPath(item, s.messageIdPath ?? this.cfg.response.messageIdPath));
      const providerStatus = text(getPath(item, s.statusPath));
      const state = this.mapState(providerStatus);
      if (!providerMessageId || !state) continue;
      out.push({
        providerMessageId,
        state,
        providerStatus,
        errorMessage: (s.errorMessagePath && text(getPath(item, s.errorMessagePath))) || undefined,
        occurredAt: new Date(),
        raw: item,
      });
    }
    return out;
  }

  async getBalance(): Promise<ProviderBalance> {
    const checkedAt = new Date();
    if (!this.cfg.balanceUrl || !this.cfg.balance) return { available: null, currency: this.cfg.currency, checkedAt };
    const { status, json } = await this.call('GET', this.cfg.balanceUrl);
    if (status < 200 || status >= 300) throw new Error(`Balance check returned HTTP ${status}`);
    const n = Number(getPath(json, this.cfg.balance.path));
    return { available: Number.isFinite(n) ? n : null, currency: this.cfg.currency, checkedAt };
  }

  /** Generic HTTP providers have no purchase API: capacity is bought out of band and recorded here. */
  async purchaseCapacity(req: PurchaseCapacityRequest): Promise<PurchaseCapacityResult> {
    return { accepted: true, providerReference: `MANUAL-${req.reference}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`, unitCost: req.unitCost, raw: { manual: true } };
  }

  async registerSenderId(_req: RegisterSenderIdRequest): Promise<RegisterSenderIdResult> {
    return { status: 'REGISTERED', message: 'This provider has no sender registration API; register the sender ID with them directly.' };
  }
}
