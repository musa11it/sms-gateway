import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { queue } from '../../workers/queue';

/**
 * Email delivery uses an outbox: every email is persisted, then a job hands it to the
 * configured driver. Only the "log" driver exists today (writes to the server log and the
 * development mailbox); an SMTP/SES driver implements `MailDriver` without touching callers.
 */
export interface MailDriver {
  send(msg: { to: string; subject: string; text: string; html?: string | null }): Promise<void>;
}

class LogMailDriver implements MailDriver {
  async send(msg: { to: string; subject: string; text: string }) {
    logger.info({ to: msg.to, subject: msg.subject }, `✉️  Email (log driver)\n${msg.text}`);
  }
}

const driver: MailDriver = new LogMailDriver();

export async function sendEmail(input: { to: string; subject: string; text: string; template: string }) {
  const email = await prisma.emailMessage.create({ data: { ...input } });
  await queue.enqueue('email.send', { emailId: email.id });
  return email;
}

export async function deliverEmail(emailId: string) {
  const email = await prisma.emailMessage.findUnique({ where: { id: emailId } });
  if (!email || email.status === 'SENT') return;
  try {
    await driver.send(email);
    await prisma.emailMessage.update({ where: { id: emailId }, data: { status: 'SENT', sentAt: new Date(), error: null } });
  } catch (err) {
    await prisma.emailMessage.update({
      where: { id: emailId },
      data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

export const mailFrom = env.MAIL_FROM;
