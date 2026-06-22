// api/send-contract.js
// Sends the contract signing link to the client.
// Optionally attaches an invoice PDF in the same email when invoiceData is provided.

import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';

export const config = { runtime: 'nodejs' };

const resend = new Resend(process.env.RESEND_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    bookingId,
    clientEmail,
    clientName,
    eventTitle,
    eventDate,
    contractUrl,        // the signing link
    invoiceData,        // optional — if present, attach invoice PDF
  } = req.body;

  if (!clientEmail || !contractUrl) {
    return res.status(400).json({ error: 'Missing clientEmail or contractUrl' });
  }

  try {
    // Build invoice attachment if requested
    let attachments = [];
    if (invoiceData && invoiceData.lineItems && invoiceData.total) {
      const pdfBuffer = await buildInvoicePDF(invoiceData);
      const filename = `Invoice_ShineTheMentalist_${(invoiceData.invoiceNumber || 'Invoice').replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;
      attachments = [{ filename, content: pdfBuffer.toString('base64') }];
    }

    const hasInvoice = attachments.length > 0;
    const invoiceNote = hasInvoice
      ? `\n\nI've also attached your invoice for this event. A ${invoiceData.depositPercent || 50}% deposit is required to secure the date — payment details are on page 2 of the invoice.`
      : '';

    const htmlInvoiceNote = hasInvoice
      ? `<p>I've also attached your invoice. A <strong>${invoiceData.depositPercent || 50}% deposit</strong> is required to secure the date — payment details are on page 2 of the invoice.</p>`
      : '';

    const result = await resend.emails.send({
      from: 'Shine, The Mentalist <shine@texasmentalist.com>',
      to: [clientEmail],
      subject: `Performance Agreement – ${eventTitle || 'Your Event'} | Shine, The Mentalist`,
      text: `Hi ${clientName || 'there'},

I'm excited to be performing at ${eventTitle || 'your event'}${eventDate ? ` on ${eventDate}` : ''}!

Please review and sign the performance agreement using the link below:
${contractUrl}

This takes just a minute and locks in your date.${invoiceNote}

Looking forward to an unforgettable performance!

– Shine
texasmentalist.com`,
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#1a1a2e">
          <div style="border-bottom:3px solid #B8960C;padding-bottom:16px;margin-bottom:24px">
            <h2 style="margin:0;font-size:22px">Shine, The Mentalist</h2>
            <a href="https://texasmentalist.com" style="color:#B8960C;font-size:13px;text-decoration:none">texasmentalist.com</a>
          </div>
          <p>Hi ${clientName || 'there'},</p>
          <p>I'm excited to be performing at <strong>${eventTitle || 'your event'}</strong>${eventDate ? ` on <strong>${eventDate}</strong>` : ''}!</p>
          <p>Please review and sign the performance agreement using the button below — it only takes a minute and locks in your date.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${contractUrl}"
               style="background:#B8960C;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold;display:inline-block">
              ✍️ Review &amp; Sign Agreement
            </a>
          </div>
          ${htmlInvoiceNote}
          <p>Looking forward to an unforgettable performance!</p>
          <p>– Shine</p>
          <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
            Shine, The Mentalist &nbsp;|&nbsp; texasmentalist.com &nbsp;|&nbsp; 2020shine@gmail.com
          </div>
        </div>
      `,
      attachments,
    });

    // Update booking status in Supabase if we have a bookingId
    if (bookingId) {
      await supabase
        .from('bookings')
        .update({ contract_status: 'sent' })
        .eq('id', bookingId);
    }

    res.status(200).json({
      success: true,
      emailId: result.id,
      invoiceAttached: hasInvoice,
    });
  } catch (err) {
    console.error('send-contract error:', err);
    res.status(500).json({ error: 'Failed to send contract', detail: err.message });
  }
}

// ── PDF builder ───────────────────────────────────────────────────────────────
function buildInvoicePDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const GOLD = '#B8960C';
    const DARK = '#1a1a2e';
    const GRAY = '#6b7280';
    const LIGHT_GRAY = '#f3f4f6';
    const WHITE = '#ffffff';

    doc.font('Helvetica-Bold').fontSize(22).fillColor(DARK).text('Shine, The Mentalist', 150, 50);
    doc.font('Helvetica').fontSize(10).fillColor(GOLD).text('texasmentalist.com', 150, 76);
    doc.font('Helvetica-Bold').fontSize(28).fillColor(GOLD)
       .text('INVOICE', 400, 50, { align: 'right', width: 145 });
    doc.moveTo(50, 105).lineTo(562, 105).lineWidth(2).strokeColor(GOLD).stroke();
    doc.moveTo(50, 108).lineTo(562, 108).lineWidth(0.5).strokeColor(DARK).stroke();

    let y = 128;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('BILL TO', 50, y);
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('INVOICE DETAILS', 350, y, { align: 'right', width: 212 });
    y += 14;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(data.clientCompany || data.clientName, 50, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK)
       .text(`Invoice #: ${data.invoiceNumber}`, 350, y, { align: 'right', width: 212 });
    y += 16;
    if (data.contactName) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.contactName, 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(DARK)
       .text(`Invoice Date: ${data.invoiceDate}`, 350, y, { align: 'right', width: 212 });
    y += 14;
    if (data.clientCity) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientCity, 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(DARK)
       .text(`Due Date: ${data.dueDate}`, 350, y, { align: 'right', width: 212 });
    y += 14;
    if (data.clientPhone) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientPhone, 50, y);

    y += 32;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('EVENT DETAILS', 50, y);
    y += 10;
    const eventRows = [
      ['Event', data.eventName],
      ['Date', data.eventDate],
      ['Time', data.eventTime],
      ['Venue', data.venue],
      ['Guests', data.guests],
    ].filter(r => r[1]);
    eventRows.forEach((row, i) => {
      const rowY = y + i * 22;
      doc.rect(50, rowY, 512, 22).fillColor(i % 2 === 0 ? LIGHT_GRAY : WHITE).fill();
      doc.rect(50, rowY, 512, 22).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(row[0], 58, rowY + 6);
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(row[1], 200, rowY + 6);
    });

    y += eventRows.length * 22 + 20;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('SERVICES', 50, y);
    y += 10;
    doc.rect(50, y, 512, 22).fillColor(DARK).fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(WHITE)
       .text('Description', 58, y + 6).text('Details', 210, y + 6)
       .text('Amount', 468, y + 6, { align: 'right', width: 86 });
    y += 22;
    data.lineItems.forEach((item) => {
      const descH = doc.heightOfString(item.description, { width: 140, fontSize: 10 });
      const detH = doc.heightOfString(item.details, { width: 240, fontSize: 10 });
      const rowH = Math.max(descH, detH) + 16;
      doc.rect(50, y, 512, rowH).fillColor(WHITE).fill();
      doc.rect(50, y, 512, rowH).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(item.description, 58, y + 8, { width: 140 });
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(item.details, 210, y + 8, { width: 240 });
      doc.font('Helvetica').fontSize(10).fillColor(DARK)
         .text(`$${Number(item.amount).toLocaleString()}`, 468, y + 8, { align: 'right', width: 86 });
      y += rowH;
    });
    doc.rect(50, y, 512, 28).strokeColor(GOLD).lineWidth(1.5).stroke();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('TOTAL', 350, y + 8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(GOLD)
       .text(`$${Number(data.total).toLocaleString()}`, 468, y + 8, { align: 'right', width: 86 });
    y += 28;
    const deposit = data.depositPercent || 50;
    const depositAmt = Math.round(data.total * deposit / 100).toLocaleString();
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY)
       .text(`* A ${deposit}% deposit ($${depositAmt}) is required to secure the date. Remaining balance due on or before ${data.eventDate}.`,
             50, y + 8, { width: 512 });
    y += 30;
    doc.moveTo(50, y + 10).lineTo(562, y + 10).lineWidth(1).strokeColor(GOLD).stroke();
    doc.moveTo(50, y + 13).lineTo(562, y + 13).lineWidth(0.3).strokeColor(DARK).stroke();

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Payment Methods', 50, 60);
    doc.font('Helvetica').fontSize(11).fillColor(DARK)
       .text('Zelle: 2020shine@gmail.com', 50, 85)
       .text('Venmo: @Shine-Thankappan', 50, 102)
       .text('PayPal: shine_e_thankappan@yahoo.com', 50, 119)
       .text('Check payable to: Shine Thankappan', 50, 136)
       .text('Cash also accepted', 50, 153);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Payment Terms', 50, 185);
    doc.font('Helvetica').fontSize(11).fillColor(DARK)
       .text(`${deposit}% deposit due upon booking.`, 50, 205)
       .text('Balance due on day of performance.', 50, 222)
       .text('Cancellation policy per agreement.', 50, 239);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Questions?', 50, 270);
    doc.font('Helvetica').fontSize(11).fillColor(DARK)
       .text('texasmentalist.com', 50, 290).text('2020shine@gmail.com', 50, 307);
    doc.font('Helvetica').fontSize(10).fillColor(GRAY)
       .text('Thank you for choosing Shine, The Mentalist — looking forward to an unforgettable evening!',
             50, 340, { align: 'center', width: 512 });
    doc.moveTo(50, 360).lineTo(562, 360).lineWidth(1).strokeColor(GOLD).stroke();
    doc.end();
  });
}
