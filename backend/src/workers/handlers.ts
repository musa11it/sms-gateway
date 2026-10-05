import { deliverEmail } from '../integrations/email/mailer';
import { verifyAndApply } from '../modules/payments/payment.service';
import { dispatchMessage } from '../modules/sms/sms.service';
import { checkLowBalance } from '../modules/wallet/wallet.service';
import { deliverWebhook } from '../modules/webhooks/webhook.service';
import { queue } from './queue';

/** Register job handlers on the queue. Called by whichever process runs workers. */
export function registerJobHandlers() {
  queue.process('sms.dispatch', ({ messageId }) => dispatchMessage(messageId), 4);
  queue.process('webhook.deliver', ({ deliveryId }) => deliverWebhook(deliveryId), 10);
  queue.process('wallet.lowBalanceCheck', ({ organizationId }) => checkLowBalance(organizationId), 5);
  queue.process('email.send', ({ emailId }) => deliverEmail(emailId), 5);
  queue.process('payment.verify', async ({ paymentId }) => {
    await verifyAndApply(paymentId);
  }, 5);
}
