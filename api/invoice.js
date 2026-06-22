// api/invoice.js
// Handles both generate (download) and send (email) in one serverless function.
// POST with { action: 'generate', ...invoiceData }  → returns { pdf: base64, filename }
// POST with { action: 'send', invoiceData, toEmail, toName, customMessage? } → returns { success }

import { Resend } from 'resend';
import PDFDocument from 'pdfkit';

export const config = { runtime: 'nodejs' };

const resend = new Resend(process.env.RESEND_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  if (action === 'generate') {
    try {
      const pdfBuffer = await buildInvoicePDF(req.body);
      const filename  = safeFilename(req.body);
      res.status(200).json({ pdf: pdfBuffer.toString('base64'), filename });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate invoice', detail: err.message });
    }

  } else if (action === 'send') {
    const { invoiceData, toEmail, toName, customMessage } = req.body;
    if (!invoiceData || !toEmail) return res.status(400).json({ error: 'Missing invoiceData or toEmail' });
    try {
      const pdfBuffer = await buildInvoicePDF(invoiceData);
      const filename  = safeFilename(invoiceData);
      const deposit   = invoiceData.depositPercent || 50;
      const depositAmt = Math.round(invoiceData.total * deposit / 100).toLocaleString();
      const body = customMessage ||
        `Please find your invoice attached for the ${invoiceData.eventName || 'upcoming event'}.\n\nA ${deposit}% deposit ($${depositAmt}) is required to secure your date — payment details are on page 2 of the invoice.\n\nLooking forward to an unforgettable performance!`;

      const result = await resend.emails.send({
        from: 'Shine, The Mentalist <shine@texasmentalist.com>',
        to:   [toEmail],
        subject: `Invoice – ${invoiceData.eventName || 'Your Event'} | Shine, The Mentalist`,
        text: `Hi ${toName || 'there'},\n\n${body}\n\n– Shine\ntexasmentalist.com`,
        html: `
          <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#1a1a2e">
            <div style="border-bottom:3px solid #B8960C;padding-bottom:16px;margin-bottom:24px">
              <h2 style="margin:0;font-size:22px">Shine, The Mentalist</h2>
              <a href="https://texasmentalist.com" style="color:#B8960C;font-size:13px;text-decoration:none">texasmentalist.com</a>
            </div>
            <p>Hi ${toName || 'there'},</p>
            ${body.split('\n').map(l => l ? `<p style="margin:6px 0">${l}</p>` : '<br>').join('')}
            <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
              Shine, The Mentalist &nbsp;|&nbsp; texasmentalist.com &nbsp;|&nbsp; 2020shine@gmail.com
            </div>
          </div>`,
        attachments: [{ filename, content: pdfBuffer.toString('base64') }],
      });
      res.status(200).json({ success: true, emailId: result.id });
    } catch (err) {
      res.status(500).json({ error: 'Failed to send invoice', detail: err.message });
    }

  } else {
    res.status(400).json({ error: 'Invalid action. Use "generate" or "send".' });
  }
}

function safeFilename(data) {
  const company = (data.clientCompany || data.clientName || 'Client').replace(/\s+/g, '_');
  return `Invoice_ShineTheMentalist_${company}.pdf`;
}

// ── PDF builder ────────────────────────────────────────────────────────────────
function buildInvoicePDF(data) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const GOLD  = '#B8960C';
    const DARK  = '#1a1a2e';
    const GRAY  = '#6b7280';
    const LG    = '#f3f4f6';
    const WHITE = '#ffffff';

    // Header
    doc.font('Helvetica-Bold').fontSize(22).fillColor(DARK).text('Shine, The Mentalist', 150, 50);
    doc.font('Helvetica').fontSize(10).fillColor(GOLD).text('texasmentalist.com', 150, 76);
    doc.font('Helvetica-Bold').fontSize(28).fillColor(GOLD).text('INVOICE', 400, 50, { align:'right', width:145 });
    doc.moveTo(50,105).lineTo(562,105).lineWidth(2).strokeColor(GOLD).stroke();
    doc.moveTo(50,108).lineTo(562,108).lineWidth(0.5).strokeColor(DARK).stroke();

    // Bill To / Invoice Meta
    let y = 128;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('BILL TO', 50, y);
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('INVOICE DETAILS', 350, y, { align:'right', width:212 });
    y += 14;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(data.clientCompany || data.clientName || '', 50, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(`Invoice #: ${data.invoiceNumber || ''}`, 350, y, { align:'right', width:212 });
    y += 16;
    if (data.contactName) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.contactName, 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(DARK).text(`Invoice Date: ${data.invoiceDate || ''}`, 350, y, { align:'right', width:212 });
    y += 14;
    if (data.clientCity) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientCity, 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(DARK).text(`Due Date: ${data.dueDate || ''}`, 350, y, { align:'right', width:212 });
    y += 14;
    if (data.clientPhone) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientPhone, 50, y);

    // Event Details table
    y += 32;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('EVENT DETAILS', 50, y);
    y += 10;
    const eventRows = [['Event',data.eventName],['Date',data.eventDate],['Time',data.eventTime],['Venue',data.venue],['Guests',data.guests]].filter(r=>r[1]);
    eventRows.forEach((row, i) => {
      const ry = y + i * 22;
      doc.rect(50,ry,512,22).fillColor(i%2===0?LG:WHITE).fill();
      doc.rect(50,ry,512,22).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(row[0],58,ry+6);
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(row[1],200,ry+6);
    });

    // Services table
    y += eventRows.length * 22 + 20;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('SERVICES', 50, y);
    y += 10;
    doc.rect(50,y,512,22).fillColor(DARK).fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(WHITE)
       .text('Description',58,y+6).text('Details',210,y+6).text('Amount',468,y+6,{align:'right',width:86});
    y += 22;
    (data.lineItems || []).forEach(item => {
      const dh = doc.heightOfString(item.description||'',{width:140,fontSize:10});
      const th = doc.heightOfString(item.details||'',{width:240,fontSize:10});
      const rh = Math.max(dh,th) + 16;
      doc.rect(50,y,512,rh).fillColor(WHITE).fill();
      doc.rect(50,y,512,rh).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(item.description||'',58,y+8,{width:140});
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(item.details||'',210,y+8,{width:240});
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text('$'+Number(item.amount||0).toLocaleString(),468,y+8,{align:'right',width:86});
      y += rh;
    });

    // Total
    doc.rect(50,y,512,28).strokeColor(GOLD).lineWidth(1.5).stroke();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('TOTAL',350,y+8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(GOLD).text('$'+Number(data.total||0).toLocaleString(),468,y+8,{align:'right',width:86});
    y += 28;

    const dep    = data.depositPercent || 50;
    const depAmt = Math.round((data.total||0)*dep/100).toLocaleString();
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY)
       .text(`* A ${dep}% deposit ($${depAmt}) is required to secure the date. Remaining balance due on or before ${data.eventDate||''}.`,50,y+8,{width:512});
    y += 30;
    doc.moveTo(50,y+10).lineTo(562,y+10).lineWidth(1).strokeColor(GOLD).stroke();
    doc.moveTo(50,y+13).lineTo(562,y+13).lineWidth(0.3).strokeColor(DARK).stroke();

    // Page 2 — payment info
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Payment Methods',50,60);
    doc.font('Helvetica').fontSize(11).fillColor(DARK)
       .text('Zelle: 2020shine@gmail.com',50,85)
       .text('Venmo: @Shine-Thankappan',50,102)
       .text('PayPal: shine_e_thankappan@yahoo.com',50,119)
       .text('Check payable to: Shine Thankappan',50,136)
       .text('Cash also accepted',50,153);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Payment Terms',50,185);
    doc.font('Helvetica').fontSize(11).fillColor(DARK)
       .text(`${dep}% deposit due upon booking.`,50,205)
       .text('Balance due on day of performance.',50,222)
       .text('Cancellation policy per agreement.',50,239);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Questions?',50,270);
    doc.font('Helvetica').fontSize(11).fillColor(DARK)
       .text('texasmentalist.com',50,290).text('2020shine@gmail.com',50,307);
    doc.font('Helvetica').fontSize(10).fillColor(GRAY)
       .text('Thank you for choosing Shine, The Mentalist — looking forward to an unforgettable evening!',50,340,{align:'center',width:512});
    doc.moveTo(50,360).lineTo(562,360).lineWidth(1).strokeColor(GOLD).stroke();
    doc.end();
  });
}
