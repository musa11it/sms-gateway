import { useState } from 'react';
import { BookOpen, FlaskConical, KeyRound, ListTree, Rocket, Ruler, Send, ShieldCheck, Timer, TriangleAlert, Webhook } from 'lucide-react';
import { LinkButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Feedback';
import { CodeBlock, PageHeader, SegmentedControl } from '@/components/ui/Misc';
import { useSystemInfo } from '@/hooks/useAuth';
import { cn } from '@/utils/format';

type Lang = 'curl' | 'js' | 'node' | 'php' | 'python';
const LANGS: { value: Lang; label: string }[] = [
  { value: 'curl', label: 'cURL' },
  { value: 'js', label: 'JavaScript' },
  { value: 'node', label: 'Node.js' },
  { value: 'php', label: 'PHP' },
  { value: 'python', label: 'Python' },
];

const base = `${window.location.origin}/api/v1`;

const sendExamples: Record<Lang, string> = {
  curl: `curl -X POST ${base}/public/sms/send \\
  -H "Authorization: Bearer $SMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042-ready" \\
  -d '{
    "senderId": "MYSHOP",
    "to": ["+250788123456"],
    "message": "Your order is ready."
  }'`,
  js: `// Browser code must never contain your API key — call this from your backend.
const res = await fetch('${base}/public/sms/send', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.SMS_API_KEY}\`,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'order-1042-ready',
  },
  body: JSON.stringify({ senderId: 'MYSHOP', to: ['+250788123456'], message: 'Your order is ready.' }),
});
const data = await res.json();
if (!data.success) throw new Error(\`\${data.code}: \${data.message}\`);
console.log(data.messageId);`,
  node: `// Node.js 18+ (built-in fetch)
async function sendSms(to, message) {
  const res = await fetch('${base}/public/sms/send', {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${process.env.SMS_API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ senderId: 'MYSHOP', to: [to], message }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(\`\${res.status} \${body.code}: \${body.message}\`);
  return body.messageId;
}

sendSms('+250788123456', 'Your order is ready.').then(console.log);`,
  php: `<?php
$ch = curl_init('${base}/public/sms/send');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . getenv('SMS_API_KEY'),
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'senderId' => 'MYSHOP',
        'to' => ['+250788123456'],
        'message' => 'Your order is ready.',
    ]),
]);
$response = json_decode(curl_exec($ch), true);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($status >= 400) {
    throw new Exception($response['code'] . ': ' . $response['message']);
}
echo $response['messageId'];`,
  python: `import os
import requests

res = requests.post(
    "${base}/public/sms/send",
    headers={"Authorization": f"Bearer {os.environ['SMS_API_KEY']}"},
    json={"senderId": "MYSHOP", "to": ["+250788123456"], "message": "Your order is ready."},
    timeout=15,
)
body = res.json()
if not res.ok:
    raise RuntimeError(f"{body['code']}: {body['message']}")
print(body["messageId"])`,
};

const statusExamples: Record<Lang, string> = {
  curl: `curl ${base}/public/sms/MESSAGE_ID \\
  -H "Authorization: Bearer $SMS_API_KEY"`,
  js: `const res = await fetch('${base}/public/sms/' + messageId, {
  headers: { Authorization: \`Bearer \${process.env.SMS_API_KEY}\` },
});
const { data } = await res.json();
console.log(data.status); // QUEUED | PROCESSING | SENT | DELIVERED | FAILED | EXPIRED`,
  node: `const res = await fetch(\`${base}/public/sms/\${messageId}\`, {
  headers: { Authorization: \`Bearer \${process.env.SMS_API_KEY}\` },
});
const { data } = await res.json();
console.log(data.status, data.error);`,
  php: `$ch = curl_init('${base}/public/sms/' . $messageId);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . getenv('SMS_API_KEY')]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$data = json_decode(curl_exec($ch), true)['data'];
echo $data['status'];`,
  python: `res = requests.get(
    f"${base}/public/sms/{message_id}",
    headers={"Authorization": f"Bearer {os.environ['SMS_API_KEY']}"},
)
print(res.json()["data"]["status"])`,
};

const verifyExamples: Record<Lang, string> = {
  curl: `# Signature header format:
# X-SmsGateway-Signature: t=1727520000,v1=<hex HMAC-SHA256 of "t.rawBody">`,
  js: `// See the Node.js tab — verify signatures on your server, never in the browser.`,
  node: `import crypto from 'crypto';

// Use the raw request body (e.g. express.raw({ type: 'application/json' })).
function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
}`,
  php: `function verify_webhook(string $rawBody, string $header, string $secret): bool {
    parse_str(str_replace(',', '&', $header), $parts);
    $t = (int) ($parts['t'] ?? 0);
    if (!$t || abs(time() - $t) > 300) return false;
    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    return hash_equals($expected, $parts['v1'] ?? '');
}

$valid = verify_webhook(file_get_contents('php://input'), $_SERVER['HTTP_X_SMSGATEWAY_SIGNATURE'] ?? '', getenv('WEBHOOK_SECRET'));`,
  python: `import hashlib, hmac, time

def verify_webhook(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", 0))
    if not t or abs(time.time() - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))`,
};

const ERRORS = [
  ['400', 'BAD_REQUEST / INVALID_JSON', 'Malformed request'],
  ['401', 'INVALID_API_KEY / API_KEY_REVOKED / API_KEY_EXPIRED', 'Missing, wrong, revoked or expired key'],
  ['402', 'INSUFFICIENT_CREDITS', 'Not enough credits for segments × recipients'],
  ['403', 'ORGANIZATION_SUSPENDED / ORGANIZATION_NOT_APPROVED / SCOPE_MISSING / IP_NOT_ALLOWED / API_KEY_DISABLED', 'Account or key not allowed to perform this action'],
  ['404', 'NOT_FOUND', 'Message not found (or belongs to another account)'],
  ['422', 'VALIDATION_ERROR / SENDER_NOT_APPROVED / INVALID_RECIPIENTS / MESSAGE_TOO_LONG', 'Request is well-formed but not acceptable'],
  ['429', 'RATE_LIMITED / SMS_RATE_LIMITED', 'Too many requests, or hourly sending limit reached — back off and retry'],
  ['503', 'PROVIDER_CAPACITY_UNAVAILABLE', 'Temporary lack of network capacity — retry later with the same Idempotency-Key'],
  ['500', 'INTERNAL_ERROR', 'Unexpected error — safe to retry with the same Idempotency-Key'],
];

const SECTIONS = [
  { id: 'start', label: 'Getting started', icon: Rocket },
  { id: 'auth', label: 'Authentication', icon: KeyRound },
  { id: 'send', label: 'Send SMS', icon: Send },
  { id: 'status', label: 'Check message', icon: BookOpen },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
  { id: 'segments', label: 'SMS segmentation', icon: Ruler },
  { id: 'errors', label: 'Errors', icon: TriangleAlert },
  { id: 'limits', label: 'Rate limits', icon: Timer },
  { id: 'reference', label: 'API reference', icon: ListTree },
  { id: 'testing', label: 'Testing', icon: FlaskConical },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-relaxed text-slate-600">{children}</div>
    </section>
  );
}

export function DocsPage() {
  const [lang, setLang] = useState<Lang>('curl');
  const { data: sys } = useSystemInfo();
  return (
    <div className="space-y-6">
      <PageHeader
        title="API documentation"
        description="Send SMS from your applications through the same secure pipeline as the dashboard."
        breadcrumbs={[{ label: 'Developer' }, { label: 'Documentation' }]}
        actions={<LinkButton to="/app/developer/api-keys">Get an API key</LinkButton>}
      />
      <div className="grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <ul className="sticky top-24 space-y-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                  <s.icon className="h-4 w-4" /> {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <Card className="space-y-10 p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-inset ring-slate-100">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Base URL</p>
              <code className="font-mono text-sm text-slate-900">{base}</code>
            </div>
            <SegmentedControl options={LANGS} value={lang} onChange={setLang} />
          </div>

          <Section id="start" title="Getting started">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>Make sure your business is verified and you have an <strong>approved sender ID</strong> (Sender IDs page).</li>
              <li>Buy SMS credits (Wallet → Buy SMS). API messages use the same wallet as the dashboard.</li>
              <li>Create an API key under <strong>Developer → API keys</strong> and store it on your server.</li>
              <li>Send your first message with <code className="kbd">POST /public/sms/send</code> (below) and watch it in <strong>API logs</strong> and <strong>SMS history</strong>.</li>
              <li>Optionally add a webhook endpoint to receive delivery reports.</li>
            </ol>
          </Section>

          <Section id="auth" title="Authentication">
            <p>
              Every request needs an API key in the <code className="kbd">Authorization</code> header. Create keys under <strong>Developer → API keys</strong>. Keys are shown once, stored hashed, can be restricted by
              scope and IP address, and revoked at any time.
            </p>
            <CodeBlock language="http" code={'Authorization: Bearer sgw_live_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'} />
            <p>
              Keys can be <strong>disabled</strong> temporarily, <strong>rotated</strong> (a new secret is issued and the old one stops working immediately) or <strong>revoked</strong>. A key only ever acts on the
              organization that created it — organization and wallet are always resolved from the key, never from the request body.
            </p>
            <Alert tone="warning">Keep keys on your server. Never embed them in mobile apps or browser code.</Alert>
          </Section>

          <Section id="send" title="Send SMS">
            <p>
              <span className="mr-2 rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-emerald-700">POST</span>
              <code className="font-mono">/public/sms/send</code>
            </p>
            <p>
              Send to up to 1,000 numbers in <code className="kbd">to</code> (a string or an array). <code className="kbd">senderId</code> is the <em>name</em> of one of your approved sender IDs. Cost is
              calculated by the server as <strong>segments × recipients</strong>; the credits are deducted atomically, and refunded if the network rejects a number. Send an{' '}
              <code className="kbd">Idempotency-Key</code> header to safely retry without double sending.
            </p>
            <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Field</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Description</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {[
                    ['senderId', 'string', 'Your approved sender ID name, e.g. MYSHOP (alias: sender)'],
                    ['to', 'string | string[]', 'E.164 numbers, e.g. +250788123456 — up to 1,000 (aliases: recipient / recipients)'],
                    ['message', 'string', 'Text. Segment limits are set by the platform (defaults GSM-7 160/153, Unicode 70/67) — use POST /sms/estimate to check a message'],
                    ['reference', 'string?', 'Your own reference, echoed back'],
                    ['scheduledAt', 'ISO date?', 'Send later (credits reserved now)'],
                  ].map(([f, t, d]) => (
                    <tr key={f}><td className="px-4 py-2 font-mono text-xs text-slate-900">{f}</td><td className="px-4 py-2 font-mono text-xs text-slate-500">{t}</td><td className="px-4 py-2">{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CodeBlock language={LANGS.find((l) => l.value === lang)!.label} code={sendExamples[lang]} />
            <p className="font-medium text-slate-800">Response · 201 Created</p>
            <CodeBlock
              language="json"
              code={JSON.stringify(
                {
                  success: true,
                  messageId: '5f0c2b1e-8a61-4c3e-9d0a-2b7f1c3e4a55',
                  data: { batchId: 'b1d2…', status: 'QUEUED', segments: 1, encoding: 'GSM7', recipientCount: 1, totalCredits: 1, messages: [{ messageId: '5f0c2b1e-…', to: '+250788123456', status: 'QUEUED', credits: 1 }] },
                },
                null,
                2,
              )}
            />
          </Section>

          <Section id="status" title="Check a message">
            <p>
              <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">GET</span>
              <code className="font-mono">/public/sms/:messageId</code> · <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">GET</span>
              <code className="font-mono">/public/balance</code>
            </p>
            <p>
              Messages move through <code className="kbd">QUEUED → PROCESSING → SENT → DELIVERED</code>, or end in <code className="kbd">FAILED</code> / <code className="kbd">EXPIRED</code>. Delivery happens
              asynchronously — use webhooks rather than polling where possible.
            </p>
            <CodeBlock language={LANGS.find((l) => l.value === lang)!.label} code={statusExamples[lang]} />
          </Section>

          <Section id="webhooks" title="Webhooks">
            <p>
              Configure endpoints under <strong>Developer → Webhooks</strong>. Events: <code className="kbd">sms.sent</code> <code className="kbd">sms.delivered</code> <code className="kbd">sms.failed</code>{' '}
              <code className="kbd">campaign.completed</code> <code className="kbd">payment.success</code> <code className="kbd">payment.failed</code> <code className="kbd">wallet.low_balance</code>. Each request carries an event ID, a timestamp and an HMAC-SHA256 signature. Failed deliveries are retried with exponential backoff
              (up to 6 attempts over ~2.5 hours). Respond with any 2xx status to acknowledge.
            </p>
            <CodeBlock
              language="json"
              code={JSON.stringify({ id: 'sms.delivered:5f0c2b1e-…', type: 'sms.delivered', created: '2026-09-28T10:15:00.000Z', data: { messageId: '5f0c2b1e-…', to: '+250788123456', status: 'DELIVERED', deliveredAt: '2026-09-28T10:14:58.120Z' } }, null, 2)}
            />
            <p className="flex items-center gap-2 font-medium text-slate-800"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Verify the signature</p>
            <CodeBlock language={LANGS.find((l) => l.value === lang)!.label} code={verifyExamples[lang]} />
          </Section>

          <Section id="segments" title="SMS segmentation">
            <p>Long messages are split into segments; you are charged <strong>1 credit per segment per recipient</strong>. The server calculates segments — send the text and it does the rest.</p>
            <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Encoding</th><th className="px-4 py-2">Single SMS (default)</th><th className="px-4 py-2">Per segment when split (default)</th><th className="px-4 py-2">When</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  <tr><td className="px-4 py-2 font-medium">GSM-7</td><td className="px-4 py-2">160 characters</td><td className="px-4 py-2">153 characters</td><td className="px-4 py-2">Standard Latin letters, digits and common symbols</td></tr>
                  <tr><td className="px-4 py-2 font-medium">Unicode (UCS-2)</td><td className="px-4 py-2">70 characters</td><td className="px-4 py-2">67 characters</td><td className="px-4 py-2">Any emoji or character outside GSM-7 (e.g. ą, ç, “smart quotes”)</td></tr>
                </tbody>
              </table>
            </div>
            <p>
              Characters <code className="kbd">{'€ [ ] { } ~ ^ | \\'}</code> count as two in GSM-7. Example: 100 recipients × 2 segments = 200 credits. The response returns{' '}
              <code className="kbd">segments</code>, <code className="kbd">encoding</code> and <code className="kbd">totalCredits</code>.
            </p>
            <p>
              The limits above are the platform defaults and may be adjusted. To check a message before sending, call{' '}
              <code className="kbd">POST /public/sms/estimate</code> with <code className="kbd">{'{ "message": "…" }'}</code> — it returns <code className="kbd">encoding</code>,{' '}
              <code className="kbd">characterCount</code>, <code className="kbd">segmentCount</code> and <code className="kbd">creditsPerRecipient</code>. Sending always recalculates on the server.
            </p>
          </Section>

          <Section id="errors" title="Errors">
            <p>Errors always use the same shape:</p>
            <CodeBlock language="json" code={JSON.stringify({ success: false, message: 'Insufficient SMS credits: 200 required, 150 available', code: 'INSUFFICIENT_CREDITS', errors: [] }, null, 2)} />
            <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">HTTP</th><th className="px-4 py-2">Code</th><th className="px-4 py-2">Meaning</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {ERRORS.map(([s, c, d]) => (
                    <tr key={s}><td className="px-4 py-2 font-mono text-xs">{s}</td><td className="px-4 py-2 font-mono text-xs text-slate-700">{c}</td><td className="px-4 py-2">{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="limits" title="Rate limits">
            <p>
              Each API key has a per-minute request quota (default 120 requests/minute). Responses include standard <code className="kbd">RateLimit</code> headers; when exceeded you receive{' '}
              <code className="kbd">429 RATE_LIMITED</code>. Use recipients arrays for bulk sends instead of one request per number.
            </p>
          </Section>

          <Section id="reference" title="API reference">
            <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Method</th><th className="px-4 py-2">Path</th><th className="px-4 py-2">Scope</th><th className="px-4 py-2">Description</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {[
                    ['POST', '/public/sms/send', 'sms.send', 'Send SMS to one or more numbers. Headers: Idempotency-Key (optional).'],
                    ['GET', '/public/sms/:messageId', 'sms.read', 'Status, error, timestamps and credits of one message.'],
                    ['GET', '/public/balance', 'balance.read', 'Remaining SMS credits in your wallet.'],
                  ].map(([m, pth, sc, d]) => (
                    <tr key={pth}><td className="px-4 py-2 font-mono text-xs font-semibold">{m}</td><td className="px-4 py-2 font-mono text-xs">{pth}</td><td className="px-4 py-2 font-mono text-xs text-slate-500">{sc}</td><td className="px-4 py-2">{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>All responses use <code className="kbd">{'{ success, data, message }'}</code> on success and <code className="kbd">{'{ success: false, message, code, errors }'}</code> on failure. Every response carries an <code className="kbd">X-Request-Id</code> header that also appears in your API logs.</p>
          </Section>

          <Section id="testing" title="Testing">
            {sys?.smsSimulation ? (
              <Alert tone="warning" title={`This environment uses the “${sys.smsProvider}” SMS provider (simulation)`}>
                No real SMS are delivered. Delivery reports are generated realistically so you can build and test your integration.
              </Alert>
            ) : (
              <Alert tone="info">This environment is connected to a live SMS provider.</Alert>
            )}
            <ul className={cn('list-disc space-y-1 pl-5', !sys?.smsSimulation && 'opacity-60')}>
              <li>Numbers ending in <code className="kbd">0000</code> are rejected at submission (credits refunded).</li>
              <li>Numbers ending in <code className="kbd">9999</code> fail delivery with ABSENT_SUBSCRIBER.</li>
              <li>Numbers ending in <code className="kbd">8888</code> stay pending for ~2 minutes, then expire.</li>
              <li>All other numbers are delivered after a few seconds (a small deterministic share fails).</li>
            </ul>
          </Section>
        </Card>
      </div>
    </div>
  );
}
