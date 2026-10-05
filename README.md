# SMS Gateway SaaS

An SMS reseller / gateway platform. The platform owner buys SMS capacity from upstream providers
(MTN, Airtel, aggregators) and sells prepaid SMS credits to verified businesses, who send SMS and
campaigns from the dashboard or through a REST API with webhooks. The Super Admin console tracks
provider capacity, revenue, costs, margin and profit from append-only ledgers.

```
backend/   Node.js · TypeScript · Express · Prisma · PostgreSQL   (API + workers)
frontend/  React · TypeScript · Vite · Tailwind · TanStack Query   (public website, customer app, admin console)
```

## Run locally

Prerequisites: Node 20+, PostgreSQL (database `sms-gateway`). Redis is optional (only for `QUEUE_DRIVER=bullmq`).

```bash
# Backend  → http://localhost:4000
cd backend
npm install
# edit .env if your DB user/password differ (see .env.example)
npm run prisma:generate
npm run prisma:migrate      # applies migrations
npm run prisma:seed         # idempotent dev data (roles, providers + capacity, packages, demo org)
npm run dev

# Frontend → http://localhost:5173  (proxies /api to :4000)
cd frontend
npm install
npm run dev
```

Other scripts: `npm run build` (both), `npm test` (backend, uses `TEST_DATABASE_URL`), `npm run worker` (standalone worker).

## Development accounts (password `Password123!`)

| Email | Role |
|---|---|
| superadmin@example.com | Super Admin (everything, incl. providers, finance, profit) |
| admin@example.com | Admin |
| support@example.com | Support |
| finance@example.com | Finance (revenue, costs, profit, expenses, refunds) |
| operator@example.com | SMS Operator |
| customer@example.com | Owner of "Acme Retail Ltd (Demo)" |
| manager@example.com / staff@example.com | Manager / Staff of the demo org |

Emails and phone verification codes are not delivered in development — open
**http://localhost:5173/dev/mailbox** (dev outbox) for verification, reset, invitation links and OTP codes.

## Business model & accounting

| Concept | Where it lives |
|---|---|
| Provider capacity (what we bought) | `sms_providers` + append-only `provider_capacity_ledger` |
| Provider purchases (cost) | `provider_purchases` (`PUR-00001`…) |
| Customer wallets (what customers bought) | `wallets` + append-only `wallet_transactions` |
| Customer payments / sales (revenue) | `payments` (with provider fee) + `customer_purchases` |
| Refunds / other expenses | `refunds`, `expenses` |

```
Gross SMS margin = Customer revenue − Provider spend
Net profit       = Gross SMS margin − Refunds − Payment fees − Other expenses
Sale contribution = Sale revenue − Estimated provider cost of credits − Payment fee
```
Provider cost of each message uses the weighted-average cost of purchased capacity and is stored per recipient.

Sending an SMS: sender/org/wallet checks → segmentation → route each number by prefix
(MTN `+25078/9`, Airtel `+25072/3`, aggregator for everything else) → in ONE transaction:
debit the customer wallet AND reserve provider capacity → queue → provider → delivery reports.
Sends are refused (503) rather than oversold when no provider has capacity.

## Simulation mode

`SMS_PROVIDER_MODE=simulation` and `PAYMENT_PROVIDER_MODE=simulation` are clearly labelled in the UI.
Each provider has its own simulator (own balance, message IDs, routes, sender-ID registration).
Test numbers: `…0000` rejected at submission (credits refunded, capacity released), `…9999` fails delivery,
`…8888` expires after ~2 min; others are delivered after 2–8 s. Payments are approved/declined on a
simulated payer screen; the simulated gateway reports a fee (mobile money 1.5 %, card 2.9 %). Credits are
added only after the backend verifies the payment with the provider.

## Connecting real providers

1. Implement `SmsProviderAdapter` (`backend/src/integrations/sms/SmsProvider.ts`): `sendSms`, `getDeliveryStatus`,
   `parseDeliveryCallback`, `getBalance`, `purchaseCapacity`, `registerSenderId` — e.g. `MtnProductionProvider.ts`.
2. Register it in `SmsProviderFactory.ts` as `mtn-production`; put credentials in `backend/.env`.
3. Set `SMS_PROVIDER_MODE=production` and switch the provider to *Production* in Admin → SMS Providers.
4. Delivery reports arrive at `POST /api/v1/callbacks/sms/mtn-production`.

Payments work the same way via `PaymentProvider` / `PaymentProviderFactory` and `/api/v1/callbacks/payments/<name>`.
