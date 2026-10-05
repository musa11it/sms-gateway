import PDFDocument from 'pdfkit';
import type { Response } from 'express';

interface InvoiceData {
  number: string;
  customerName: string;
  customerEmail: string | null;
  billingAddress: string | null;
  taxId: string | null;
  description: string;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  currency: string;
  status: string;
  issuedAt: Date;
  payment: { reference: string; method: string; status: string };
}

const fmt = (amount: string, currency: string) => {
  const [i, f = ''] = amount.split('.');
  const cents = (f + '00').slice(0, 2);
  return `${currency} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents !== '00' ? `.${cents}` : ''}`;
};

/** Streams a simple, printable A4 invoice PDF. */
export function streamInvoicePdf(res: Response, inv: InvoiceData, issuer: { name: string; address: string }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.number}`, Author: issuer.name } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
  doc.pipe(res);

  const brand = '#4f46e5';
  const muted = '#64748b';
  doc.fillColor(brand).fontSize(22).font('Helvetica-Bold').text('INVOICE', 50, 50);
  doc.fillColor('#0f172a').fontSize(10).font('Helvetica').text(inv.number, 50, 78);
  doc.fillColor(inv.status === 'PAID' ? '#059669' : '#dc2626').font('Helvetica-Bold').text(inv.status, 50, 94);
  doc.fillColor('#0f172a').font('Helvetica-Bold').text(issuer.name, 300, 50, { width: 245, align: 'right' });
  doc.fillColor(muted).font('Helvetica').text(issuer.address, 300, 66, { width: 245, align: 'right' });
  doc.text(`Issued ${inv.issuedAt.toISOString().slice(0, 10)}`, 300, 82, { width: 245, align: 'right' });

  doc.moveTo(50, 125).lineTo(545, 125).strokeColor('#e2e8f0').stroke();
  doc.fillColor(muted).fontSize(9).text('BILLED TO', 50, 140);
  doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text(inv.customerName, 50, 154);
  doc.font('Helvetica').fontSize(10).fillColor('#334155');
  let y = 170;
  for (const line of [inv.billingAddress, inv.customerEmail, inv.taxId ? `TIN: ${inv.taxId}` : null].filter(Boolean) as string[]) {
    doc.text(line, 50, y);
    y += 14;
  }
  doc.fillColor(muted).fontSize(9).text('PAYMENT', 300, 140, { width: 245, align: 'right' });
  doc.fillColor('#0f172a').fontSize(10).text(inv.payment.reference, 300, 154, { width: 245, align: 'right' });
  doc.fillColor('#334155').text(`${inv.payment.method.replace('_', ' ').toLowerCase()} · ${inv.payment.status.toLowerCase()}`, 300, 168, { width: 245, align: 'right' });

  const top = 240;
  doc.rect(50, top, 495, 24).fill('#f1f5f9');
  doc.fillColor(muted).fontSize(9).font('Helvetica-Bold');
  doc.text('DESCRIPTION', 60, top + 8).text('QTY', 300, top + 8, { width: 60, align: 'right' }).text('UNIT PRICE', 365, top + 8, { width: 80, align: 'right' }).text('AMOUNT', 450, top + 8, { width: 85, align: 'right' });
  doc.fillColor('#0f172a').font('Helvetica').fontSize(10);
  doc.text(inv.description, 60, top + 36, { width: 230 });
  doc.text(inv.quantity.toLocaleString('en-US'), 300, top + 36, { width: 60, align: 'right' });
  doc.text(fmt(inv.unitPrice, inv.currency), 365, top + 36, { width: 80, align: 'right' });
  doc.text(fmt(inv.subtotal, inv.currency), 450, top + 36, { width: 85, align: 'right' });

  let ty = top + 90;
  const row = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? '#0f172a' : '#334155');
    doc.text(label, 330, ty, { width: 110 }).text(value, 440, ty, { width: 95, align: 'right' });
    ty += bold ? 22 : 18;
  };
  row('Subtotal', fmt(inv.subtotal, inv.currency));
  row(`Tax (${Number(inv.taxRate)}%)`, fmt(inv.taxAmount, inv.currency));
  doc.moveTo(330, ty).lineTo(545, ty).strokeColor('#e2e8f0').stroke();
  ty += 8;
  row('Total', fmt(inv.total, inv.currency), true);

  doc.fillColor(muted).fontSize(9).font('Helvetica').text('Thank you for your business.', 50, 760, { width: 495, align: 'center' });
  doc.end();
}
