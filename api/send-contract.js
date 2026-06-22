// api/send-contract.js
// Accepts event details, creates/updates the booking record, builds the
// contract signing URL, emails it to the client, and optionally attaches
// an invoice PDF — all in one call.

const { Resend } = require('resend');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');



const resend   = new Resend(process.env.RESEND_KEY);
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SECRET_KEY;
const SB_HDR   = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    clientId,
    clientName,
    clientEmail,
    bookingId,       // may be null for direct/planner clients
    eventTitle,
    venueAddress,
    clientAddress,
    eventDate,
    startTime,
    duration,
    fee,
    invoiceData,     // optional — attach invoice PDF if present
  } = req.body;

  // Coerce empty strings to null so Supabase UUID columns don't reject them
  const safeClientId  = clientId  && String(clientId).trim()  ? clientId  : null;
  const safeBookingId = bookingId && String(bookingId).trim() ? bookingId : null;

  if (!clientEmail || !clientName) {
    return res.status(400).json({ error: 'Missing clientEmail or clientName' });
  }

  try {
    // ── 1. Upsert booking record ─────────────────────────────────────────────
    let resolvedBookingId = safeBookingId;

    if (resolvedBookingId) {
      // Update existing booking with latest event details
      await fetch(`${SB_URL}/rest/v1/bookings?id=eq.${resolvedBookingId}`, {
        method: 'PATCH',
        headers: SB_HDR,
        body: JSON.stringify({
          event_title:   eventTitle   || null,
          venue_address: venueAddress || null,
          event_date:    eventDate    || null,
          start_time:    startTime    || null,
          duration:      duration     || null,
          fee:           fee          || null,
          contract_status: 'sent',
        }),
      });
      // Also update selected_price on client so dashboard card shows fee
      if (safeClientId && fee) {
        await fetch(`${SB_URL}/rest/v1/clients?id=eq.${safeClientId}`, {
          method: 'PATCH',
          headers: SB_HDR,
          body: JSON.stringify({ selected_price: fee, last_activity: new Date().toISOString() }),
        });
      }
    } else {
      // Create new booking record for planners / direct clients
      const bRes = await fetch(`${SB_URL}/rest/v1/bookings`, {
        method: 'POST',
        headers: SB_HDR,
        body: JSON.stringify({
          client_id:     safeClientId,
          client_name:   clientName,
          client_email:  clientEmail,
          event_title:   eventTitle   || null,
          venue_address: venueAddress || null,
          event_date:    eventDate    || null,
          start_time:    startTime    || null,
          duration:      duration     || null,
          fee:           fee          || null,
          contract_status: 'sent',
          intake_status:   'completed',
        }),
      });
      const bRows = await bRes.json();
      const booking = Array.isArray(bRows) ? bRows[0] : bRows;
      if (!booking?.id) throw new Error('Failed to create booking record');
      resolvedBookingId = booking.id;

      // Link booking back to client record
      if (safeClientId) {
        await fetch(`${SB_URL}/rest/v1/clients?id=eq.${safeClientId}`, {
          method: 'PATCH',
          headers: SB_HDR,
          body: JSON.stringify({ booking_id: resolvedBookingId, status: 'intake_completed', last_activity: new Date().toISOString(), selected_price: fee || null }),
        });
      }
    }

    // ── 2. Build contract signing URL ────────────────────────────────────────
    const contractUrl  = `https://shine-booking.vercel.app/contract.html?bid=${resolvedBookingId}`;
    const contractLink = contractUrl; // alias returned to caller

    // ── 3. Optional invoice attachment ───────────────────────────────────────
    let attachments = [];
    if (invoiceData && invoiceData.lineItems && invoiceData.total) {
      const pdfBuffer = await buildInvoicePDF(invoiceData);
      const filename  = `Invoice_ShineTheMentalist_${(invoiceData.invoiceNumber || 'Invoice').replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;
      attachments = [{ filename, content: pdfBuffer.toString('base64') }];
    }

    const hasInvoice    = attachments.length > 0;
    const dep           = invoiceData?.depositPercent || 50;
    const invoiceNote   = hasInvoice ? `\n\nI've also attached your invoice. A ${dep}% deposit is required to secure the date — payment details are on page 2.` : '';
    const htmlInvNote   = hasInvoice ? `<p>I've also attached your invoice. A <strong>${dep}% deposit</strong> is required to secure the date — payment details are on page 2.</p>` : '';

    // ── 4. Send email ────────────────────────────────────────────────────────
    const firstName = (clientName || 'there').split(' ')[0];
    await resend.emails.send({
      from:    'Shine, The Mentalist <shine@texasmentalist.com>',
      to:      [clientEmail],
      subject: `Performance Agreement – ${eventTitle || 'Your Event'} | Shine, The Mentalist`,
      text: `Hi ${firstName},\n\nI'm excited to be performing at ${eventTitle || 'your event'}${eventDate ? ` on ${eventDate}` : ''}!\n\nPlease review and sign the performance agreement:\n${contractUrl}\n\nThis takes just a minute and locks in your date.${invoiceNote}\n\nLooking forward to an unforgettable performance!\n\n– Shine\ntexasmentalist.com`,
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#1a1a2e">
          <div style="border-bottom:3px solid #B8960C;padding-bottom:16px;margin-bottom:24px">
            <h2 style="margin:0;font-size:22px">Shine, The Mentalist</h2>
            <a href="https://texasmentalist.com" style="color:#B8960C;font-size:13px;text-decoration:none">texasmentalist.com</a>
          </div>
          <p>Hi ${firstName},</p>
          <p>I'm excited to be performing at <strong>${eventTitle || 'your event'}</strong>${eventDate ? ` on <strong>${eventDate}</strong>` : ''}!</p>
          <p>Please review and sign the performance agreement using the button below — it only takes a minute and locks in your date.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${contractUrl}" style="background:#B8960C;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold;display:inline-block">
              ✍️ Review &amp; Sign Agreement
            </a>
          </div>
          ${htmlInvNote}
          <p>Looking forward to an unforgettable performance!</p>
          <p>– Shine</p>
          <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
            Shine, The Mentalist &nbsp;|&nbsp; texasmentalist.com &nbsp;|&nbsp; 2020shine@gmail.com
          </div>
        </div>`,
      attachments,
    });

    return res.status(200).json({
      success:         true,
      contractLink,
      bookingId:       resolvedBookingId,
      invoiceAttached: hasInvoice,
    });

  } catch (err) {
    console.error('send-contract error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── PDF builder ───────────────────────────────────────────────────────────────
function buildInvoicePDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const GOLD = '#B8960C', DARK = '#1a1a2e', GRAY = '#6b7280', LG = '#f3f4f6', WHITE = '#ffffff';

    doc.font('Helvetica-Bold').fontSize(22).fillColor(DARK).text('Shine, The Mentalist', 150, 50);
    doc.font('Helvetica').fontSize(10).fillColor(GOLD).text('texasmentalist.com', 150, 76);
    doc.font('Helvetica-Bold').fontSize(28).fillColor(GOLD).text('INVOICE', 400, 50, { align:'right', width:145 });
    doc.moveTo(50,105).lineTo(562,105).lineWidth(2).strokeColor(GOLD).stroke();
    doc.moveTo(50,108).lineTo(562,108).lineWidth(0.5).strokeColor(DARK).stroke();

    let y = 128;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('BILL TO', 50, y);
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('INVOICE DETAILS', 350, y, { align:'right', width:212 });
    y += 14;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(data.clientCompany || data.clientName || '', 50, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(`Invoice #: ${data.invoiceNumber||''}`, 350, y, { align:'right', width:212 });
    y += 16;
    if (data.contactName) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.contactName, 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(DARK).text(`Invoice Date: ${data.invoiceDate||''}`, 350, y, { align:'right', width:212 });
    y += 14;
    if (data.clientCity) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientCity, 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(DARK).text(`Due Date: ${data.dueDate||''}`, 350, y, { align:'right', width:212 });
    y += 14;
    if (data.clientPhone) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientPhone, 50, y);

    y += 32;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('EVENT DETAILS', 50, y); y += 10;
    const eRows = [['Event',data.eventName],['Date',data.eventDate],['Time',data.eventTime],['Venue',data.venue],['Guests',data.guests]].filter(r=>r[1]);
    eRows.forEach((row,i) => {
      const ry = y + i*22;
      doc.rect(50,ry,512,22).fillColor(i%2===0?LG:WHITE).fill();
      doc.rect(50,ry,512,22).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(row[0],58,ry+6);
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(row[1],200,ry+6);
    });

    y += eRows.length*22 + 20;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('SERVICES', 50, y); y += 10;
    doc.rect(50,y,512,22).fillColor(DARK).fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(WHITE).text('Description',58,y+6).text('Details',210,y+6).text('Amount',468,y+6,{align:'right',width:86});
    y += 22;
    (data.lineItems||[]).forEach(item => {
      const dh = doc.heightOfString(item.description||'',{width:140,fontSize:10});
      const th = doc.heightOfString(item.details||'',{width:240,fontSize:10});
      const rh = Math.max(dh,th)+16;
      doc.rect(50,y,512,rh).fillColor(WHITE).fill();
      doc.rect(50,y,512,rh).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(item.description||'',58,y+8,{width:140});
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(item.details||'',210,y+8,{width:240});
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text('$'+Number(item.amount||0).toLocaleString(),468,y+8,{align:'right',width:86});
      y += rh;
    });
    doc.rect(50,y,512,28).strokeColor(GOLD).lineWidth(1.5).stroke();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('TOTAL',350,y+8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(GOLD).text('$'+Number(data.total||0).toLocaleString(),468,y+8,{align:'right',width:86});
    y += 28;
    const dep = data.depositPercent||50;
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(`* A ${dep}% deposit ($${Math.round((data.total||0)*dep/100).toLocaleString()}) is required to secure the date. Remaining balance due on or before ${data.eventDate||''}.`,50,y+8,{width:512});
    y += 30;
    doc.moveTo(50,y+10).lineTo(562,y+10).lineWidth(1).strokeColor(GOLD).stroke();

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Payment Methods',50,60);
    doc.font('Helvetica').fontSize(11).fillColor(DARK)
       .text('Zelle: 2020shine@gmail.com',50,85).text('Venmo: @Shine-Thankappan',50,102)
       .text('PayPal: shine_e_thankappan@yahoo.com',50,119).text('Check payable to: Shine Thankappan',50,136).text('Cash also accepted',50,153);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Payment Terms',50,185);
    doc.font('Helvetica').fontSize(11).fillColor(DARK).text(`${dep}% deposit due upon booking.`,50,205).text('Balance due on day of performance.',50,222).text('Cancellation policy per agreement.',50,239);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Questions?',50,270);
    doc.font('Helvetica').fontSize(11).fillColor(DARK).text('texasmentalist.com',50,290).text('2020shine@gmail.com',50,307);
    doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Thank you for choosing Shine, The Mentalist — looking forward to an unforgettable evening!',50,340,{align:'center',width:512});
    doc.moveTo(50,360).lineTo(562,360).lineWidth(1).strokeColor(GOLD).stroke();
    doc.end();
  });
}
