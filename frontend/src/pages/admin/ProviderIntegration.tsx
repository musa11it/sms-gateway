import { useState } from 'react';
import { Activity } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Form';
import { useApiMutation } from '@/hooks/useApiMutation';
import { businessService, type Provider } from '@/services/businessService';

/**
 * "How do we reach this provider?" — lets a Super Admin connect an upstream with a JSON HTTP API
 * from the UI. Simulation needs nothing here; every provider can be simulated out of the box.
 */

export interface IntegrationForm {
  adapterType: 'NONE' | 'HTTP_JSON';
  sendUrl: string;
  statusUrl: string;
  balanceUrl: string;
  authType: 'NONE' | 'BEARER' | 'HEADER' | 'BASIC';
  authName: string;
  apiKey: string;
  bodyTemplate: string;
  messageIdPath: string;
  successPath: string;
  successValues: string;
  errorMessagePath: string;
  statusPath: string;
  statusMessageIdPath: string;
  delivered: string;
  failed: string;
  expired: string;
  balancePath: string;
  callbackMode: 'NONE' | 'HMAC_SHA256' | 'SHARED_HEADER';
  callbackHeader: string;
  callbackSecret: string;
}

const DEFAULT_BODY = '{\n  "to": "{{to}}",\n  "from": "{{from}}",\n  "message": "{{message}}",\n  "reference": "{{reference}}"\n}';

export const emptyIntegration: IntegrationForm = {
  adapterType: 'NONE',
  sendUrl: '',
  statusUrl: '',
  balanceUrl: '',
  authType: 'BEARER',
  authName: '',
  apiKey: '',
  bodyTemplate: DEFAULT_BODY,
  messageIdPath: 'data.id',
  successPath: '',
  successValues: '',
  errorMessagePath: '',
  statusPath: 'status',
  statusMessageIdPath: '',
  delivered: 'DELIVERED',
  failed: 'FAILED, REJECTED, UNDELIVERED',
  expired: 'EXPIRED',
  balancePath: '',
  callbackMode: 'NONE',
  callbackHeader: '',
  callbackSecret: '',
};

const list = (v: string) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const join = (v?: string[]) => (v ?? []).join(', ');

export function integrationFromProvider(p: Provider | null): IntegrationForm {
  const c = p?.adapterType === 'HTTP_JSON' ? p.adapterConfig : null;
  if (!p || !c) return emptyIntegration;
  return {
    ...emptyIntegration,
    adapterType: 'HTTP_JSON',
    sendUrl: c.sendUrl ?? '',
    statusUrl: c.statusUrl ?? '',
    balanceUrl: c.balanceUrl ?? '',
    authType: c.auth?.type ?? 'BEARER',
    authName: c.auth?.name ?? '',
    bodyTemplate: c.bodyTemplate ?? DEFAULT_BODY,
    messageIdPath: c.response?.messageIdPath ?? '',
    successPath: c.response?.successPath ?? '',
    successValues: join(c.response?.successValues),
    errorMessagePath: c.response?.errorMessagePath ?? '',
    statusPath: c.status?.statusPath ?? '',
    statusMessageIdPath: c.status?.messageIdPath ?? '',
    delivered: join(c.status?.delivered),
    failed: join(c.status?.failed),
    expired: join(c.status?.expired),
    balancePath: c.balance?.path ?? '',
    callbackMode: c.callback?.mode ?? 'NONE',
    callbackHeader: c.callback?.headerName ?? '',
  };
}

export function integrationValid(f: IntegrationForm, provider: Provider | null): boolean {
  if (f.adapterType === 'NONE') return true;
  const hasKey = !!f.apiKey.trim() || !!provider?.adapterConfig?.hasApiKey;
  const hasCallbackSecret = !!f.callbackSecret.trim() || !!provider?.adapterConfig?.hasCallbackSecret;
  return (
    /^https?:\/\//i.test(f.sendUrl.trim()) &&
    f.messageIdPath.trim().length > 0 &&
    (f.authType === 'NONE' || hasKey) &&
    (f.authType !== 'HEADER' || f.authName.trim().length > 0) &&
    (f.callbackMode === 'NONE' || (f.callbackHeader.trim().length > 0 && hasCallbackSecret && f.statusPath.trim().length > 0)) &&
    (() => {
      try {
        return typeof JSON.parse(f.bodyTemplate) === 'object';
      } catch {
        return false;
      }
    })()
  );
}

/** Request fields for create/update. Secrets left empty are kept as stored by the server. */
export function integrationPayload(f: IntegrationForm) {
  if (f.adapterType === 'NONE') return { adapterType: 'NONE' as const, adapterConfig: null };
  const hasStatus = f.statusPath.trim() || f.callbackMode !== 'NONE';
  return {
    adapterType: 'HTTP_JSON' as const,
    adapterConfig: {
      sendUrl: f.sendUrl.trim(),
      statusUrl: f.statusUrl.trim() || null,
      balanceUrl: f.balanceUrl.trim() || null,
      auth: { type: f.authType, name: f.authName.trim() || null },
      bodyTemplate: f.bodyTemplate,
      response: {
        messageIdPath: f.messageIdPath.trim(),
        successPath: f.successPath.trim() || null,
        successValues: list(f.successValues),
        errorMessagePath: f.errorMessagePath.trim() || null,
      },
      status: hasStatus
        ? { statusPath: f.statusPath.trim(), messageIdPath: f.statusMessageIdPath.trim() || null, errorMessagePath: null, delivered: list(f.delivered), failed: list(f.failed), expired: list(f.expired) }
        : null,
      balance: f.balancePath.trim() ? { path: f.balancePath.trim() } : null,
      callback: f.callbackMode === 'NONE' ? null : { mode: f.callbackMode, headerName: f.callbackHeader.trim() },
      ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
      ...(f.callbackSecret.trim() ? { callbackSecret: f.callbackSecret.trim() } : {}),
    },
  };
}

export function ProviderIntegrationSection({ provider, value, onChange }: { provider: Provider | null; value: IntegrationForm; onChange: (v: IntegrationForm) => void }) {
  const set = (k: keyof IntegrationForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange({ ...value, [k]: e.target.value } as IntegrationForm);
  const http = value.adapterType === 'HTTP_JSON';
  return (
    <section>
      <h4 className="text-sm font-semibold text-slate-900">Integration</h4>
      <p className="mt-0.5 text-xs text-slate-500">How real traffic reaches this provider. Simulation works for every provider without any setup.</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Connection type" className="sm:col-span-2">
          <Select value={value.adapterType} onChange={set('adapterType')}>
            <option value="NONE">Simulation only (no real network)</option>
            <option value="HTTP_JSON">HTTP API (JSON) — configure below</option>
          </Select>
        </Field>
        {http && (
          <>
            <Field label="Send URL" required hint="Must be https://" className="sm:col-span-2"><Input value={value.sendUrl} onChange={set('sendUrl')} placeholder="https://api.provider.com/v1/sms" /></Field>
            <Field label="Authentication">
              <Select value={value.authType} onChange={set('authType')}>
                <option value="BEARER">Bearer token</option>
                <option value="HEADER">API key in a header</option>
                <option value="BASIC">Basic (user name + key)</option>
                <option value="NONE">None</option>
              </Select>
            </Field>
            {value.authType === 'HEADER' && <Field label="Header name" required><Input value={value.authName} onChange={set('authName')} placeholder="X-API-Key" /></Field>}
            {value.authType === 'BASIC' && <Field label="User name"><Input value={value.authName} onChange={set('authName')} /></Field>}
            {value.authType !== 'NONE' && (
              <Field label="API key" required={!provider?.adapterConfig?.hasApiKey} hint={provider?.adapterConfig?.hasApiKey ? 'A key is stored. Leave empty to keep it.' : 'Stored encrypted; never shown again'}>
                <Input type="password" autoComplete="off" value={value.apiKey} onChange={set('apiKey')} placeholder={provider?.adapterConfig?.hasApiKey ? '••••••••' : ''} />
              </Field>
            )}
            <Field label="Request body (JSON)" required className="sm:col-span-2" hint="Placeholders: {{to}} {{from}} {{message}} {{reference}} {{segments}} {{encoding}} {{callbackUrl}}">
              <Textarea rows={6} className="font-mono text-xs" value={value.bodyTemplate} onChange={set('bodyTemplate')} />
            </Field>
            <Field label="Message id in the response" required hint="e.g. data.id or messages[0].id"><Input value={value.messageIdPath} onChange={set('messageIdPath')} className="font-mono" /></Field>
            <Field label="Error message in the response" hint="Optional"><Input value={value.errorMessagePath} onChange={set('errorMessagePath')} className="font-mono" placeholder="error.message" /></Field>
            <Field label="Success field" hint="Optional: a field that says the send worked"><Input value={value.successPath} onChange={set('successPath')} className="font-mono" placeholder="status" /></Field>
            <Field label="Success values" hint="Comma separated"><Input value={value.successValues} onChange={set('successValues')} placeholder="queued, accepted" /></Field>

            <div className="sm:col-span-2 border-t border-slate-100 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Delivery reports</p>
            </div>
            <Field label="Status URL" hint="Optional. Use {{providerMessageId}}" className="sm:col-span-2"><Input value={value.statusUrl} onChange={set('statusUrl')} placeholder="https://api.provider.com/v1/sms/{{providerMessageId}}" /></Field>
            <Field label="Status field" hint="In the status response / callback"><Input value={value.statusPath} onChange={set('statusPath')} className="font-mono" /></Field>
            <Field label="Message id in callbacks" hint="Empty = same as the send response"><Input value={value.statusMessageIdPath} onChange={set('statusMessageIdPath')} className="font-mono" /></Field>
            <Field label="Delivered values"><Input value={value.delivered} onChange={set('delivered')} /></Field>
            <Field label="Failed values"><Input value={value.failed} onChange={set('failed')} /></Field>
            <Field label="Expired values"><Input value={value.expired} onChange={set('expired')} /></Field>
            <Field label="Balance URL" hint="Optional"><Input value={value.balanceUrl} onChange={set('balanceUrl')} /></Field>
            {value.balanceUrl.trim() && <Field label="Balance field"><Input value={value.balancePath} onChange={set('balancePath')} className="font-mono" placeholder="account.units" /></Field>}

            <Field label="Verify callbacks with" className="sm:col-span-2" hint="Callbacks without verification are rejected, so nobody can fake a delivery report">
              <Select value={value.callbackMode} onChange={set('callbackMode')}>
                <option value="NONE">Not used (we poll the status URL)</option>
                <option value="HMAC_SHA256">Signature: hex HMAC-SHA256 of the body</option>
                <option value="SHARED_HEADER">Shared secret sent in a header</option>
              </Select>
            </Field>
            {value.callbackMode !== 'NONE' && (
              <>
                <Field label="Header name" required><Input value={value.callbackHeader} onChange={set('callbackHeader')} placeholder="X-Signature" /></Field>
                <Field label="Callback secret" required={!provider?.adapterConfig?.hasCallbackSecret} hint={provider?.adapterConfig?.hasCallbackSecret ? 'A secret is stored. Leave empty to keep it.' : 'At least 8 characters'}>
                  <Input type="password" autoComplete="off" value={value.callbackSecret} onChange={set('callbackSecret')} />
                </Field>
                {provider && <p className="sm:col-span-2 break-all rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-inset ring-slate-100">Give the provider this callback URL: <span className="font-mono">{provider.callbackUrl}</span></p>}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Reads the provider's balance and optionally sends one real test message. Uses the saved configuration. */
export function ProviderTestPanel({ provider }: { provider: Provider }) {
  const [phone, setPhone] = useState('');
  const test = useApiMutation(() => businessService.testProvider(provider.id, phone.trim() ? { phone: phone.trim() } : {}), { silentError: false });
  const r = test.data;
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-100">
      <p className="text-sm font-medium text-slate-900">Test connection</p>
      <p className="text-xs text-slate-500">Tests the <strong>saved</strong> settings. Add a phone number to send one real test message (international format).</p>
      <div className="flex gap-2">
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+250788123456 (optional)" />
        <Button variant="secondary" icon={<Activity className="h-4 w-4" />} loading={test.isPending} onClick={() => test.mutate(undefined)}>Test</Button>
      </div>
      {r && (
        <div className="space-y-1 text-sm">
          <p>Adapter <Badge color={r.simulation ? 'amber' : 'green'}>{r.adapterKey}</Badge>{r.simulation && <span className="ml-2 text-xs text-slate-500">simulation: nothing real was sent</span>}</p>
          {r.balanceError ? <Alert tone="danger">Balance check failed: {r.balanceError}</Alert> : r.balance && <p className="text-slate-700">Provider balance: {r.balance.available === null ? 'not reported' : `${r.balance.available.toLocaleString()} ${r.balance.currency}`}</p>}
          {r.send && (r.send.accepted ? <p className="text-emerald-700">Test message accepted · id {r.send.providerMessageId}</p> : <Alert tone="danger">Send rejected: {r.send.errorCode} — {r.send.errorMessage}</Alert>)}
        </div>
      )}
    </div>
  );
}
