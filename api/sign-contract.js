import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { bookingId, printedName, signatureData } = req.body;
    if (!bookingId || !printedName || !signatureData) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Fetch booking
    const bookingRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}&limit=1`, {
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    });
    const bookingRows = await bookingRes.json();
    const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;
    if (!booking) {
      res.status(404).json({ error: 'Booking not found' });
      return;
    }

    const eventDateFormatted = booking.event_date
      ? new Date(booking.event_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'TBD';
    const todayDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // Build PDF
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    let page = pdfDoc.addPage([612, 792]);
    let y = 740;
    const marginX = 60;
    const maxWidth = 492;

    function wrapText(text, fontObj, size, width) {
      const words = text.split(' ');
      const lines = [];
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (fontObj.widthOfTextAtSize(test, size) > width) {
          lines.push(line);
          line = w;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
      return lines;
    }

    function drawParagraph(text, opts = {}) {
      const size = opts.size || 11;
      const f = opts.bold ? fontBold : font;
      const lines = wrapText(text, f, size, maxWidth);
      for (const line of lines) {
        if (y < 60) { page = pdfDoc.addPage([612, 792]); y = 740; }
        page.drawText(line, { x: marginX, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
        y -= size + 6;
      }
      y -= 6;
    }

    function drawHeading(text) {
      y -= 4;
      drawParagraph(text, { bold: true, size: 13 });
    }

    drawParagraph('PERFORMANCE AGREEMENT', { bold: true, size: 16 });
    y -= 6;

    drawParagraph(`This Performance Agreement ("Agreement") is entered into on ${todayDate} by and between MindGames, represented by Shine, The Mentalist ("Performer"), and ${booking.client_name} ("Client"), located at ${booking.venue_address}.`);

    drawHeading('1. PERFORMANCE DETAILS');
    drawParagraph(`Performer shall present a professional Magic & Mentalism performance for the event titled "${booking.event_title}" at ${booking.venue_address} on ${eventDateFormatted}, beginning at approximately ${booking.start_time}, for a total performance length of up to ${booking.duration}.`);

    drawHeading('2. COMPENSATION');
    drawParagraph(`The total performance fee shall be $${booking.fee}.`);
    drawParagraph('A non-refundable deposit of 25% is required to secure the event date. The remaining balance shall be paid no later than the day of the performance prior to the start time.');
    drawParagraph('Payment may be made via cash, Zelle (2020shine@gmail.com), Venmo (@Shine-Thankappan), PayPal (shine_e_thankappan@yahoo.com), or other mutually agreed method.');

    drawHeading('3. EVENT DETAILS');
    drawParagraph('Client agrees to provide adequate and safe performance space, suitable lighting, access to electrical power if required, reasonable audience control, and a safe environment.');

    drawHeading('4. CANCELLATION & RESCHEDULING');
    drawParagraph('If cancellation occurs 10 or more days prior to the event date, no additional fee will be charged beyond the deposit. If cancellation occurs fewer than 5 days prior to the event date, 100% of the agreed performance fee shall be due.');

    drawHeading('5. FORCE MAJEURE');
    drawParagraph('Neither party shall be liable for failure to perform due to events beyond reasonable control, including acts of God, government restrictions, natural disasters, illness, or unforeseen emergencies.');

    drawHeading('6. LIABILITY & INDEMNIFICATION');
    drawParagraph("Performer shall not be liable for any indirect, incidental, or consequential damages arising from the performance. Client agrees to indemnify and hold Performer harmless from claims arising from the event not caused by Performer's gross negligence or willful misconduct.");

    drawHeading('7. RECORDING & PROMOTIONAL USE');
    drawParagraph('To preserve the experience and protect original material, video recording of the performance by the Client or guests is not permitted unless approved in advance by the Performer. The Performer may record portions of the event for promotional or documentation purposes. Photography for personal use is allowed unless otherwise specified.');

    drawHeading('8. INDEPENDENT CONTRACTOR');
    drawParagraph('Performer is an independent contractor and not an employee of Client.');

    drawHeading('9. GOVERNING LAW');
    drawParagraph('This Agreement shall be governed by and construed in accordance with the laws of the State of Texas.');

    drawHeading('10. ENTIRE AGREEMENT');
    drawParagraph('This Agreement constitutes the entire understanding between the parties and supersedes all prior discussions. Any modifications must be in writing and signed by both parties.');

    // Signature section
    if (y < 220) { page = pdfDoc.addPage([612, 792]); y = 740; }
    y -= 10;
    drawHeading('SIGNATURES');

    // Embed signature image
    const sigImageBytes = signatureData.split(',')[1];
    const sigImage = await pdfDoc.embedPng(Buffer.from(sigImageBytes, 'base64'));
    const sigDims = sigImage.scale(0.35);

    page.drawText('Client Signature:', { x: marginX, y, size: 11, font: fontBold });
    y -= 14;
    page.drawImage(sigImage, { x: marginX, y: y - sigDims.height, width: sigDims.width, height: sigDims.height });
    y -= sigDims.height + 8;
    page.drawText(`Printed Name: ${printedName}`, { x: marginX, y, size: 11, font });
    y -= 16;
    page.drawText(`Date: ${todayDate}`, { x: marginX, y, size: 11, font });
    y -= 26;

    page.drawText('MindGames Signature:', { x: marginX, y, size: 11, font: fontBold });
    y -= 16;
    page.drawText('Shine, The Mentalist', { x: marginX, y, size: 11, font });
    y -= 14;
    page.drawText('Professional Mentalist', { x: marginX, y, size: 11, font });
    y -= 14;
    page.drawText(`Date: ${todayDate}`, { x: marginX, y, size: 11, font });

    const pdfBytes = await pdfDoc.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    // Email signed PDF to client
    if (booking.client_email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
        body: JSON.stringify({
          from: 'Shine, The Mentalist <shine@texasmentalist.com>',
          to: booking.client_email,
          subject: 'Your signed performance agreement',
          text: `Hi ${booking.client_name},\n\nThank you for signing the performance agreement! A copy is attached for your records.\n\nEverything is all set for your event. Looking forward to it!\n\nShine, The Mentalist\n+1 (612) 865-7681\nwww.texasmentalist.com`,
          attachments: [{ filename: 'Performance_Agreement_Signed.pdf', content: pdfBase64 }]
        })
      });
    }

    // Email signed PDF to Shine
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Shine Booking Assistant <shine@texasmentalist.com>',
        to: 'shinethementalist@gmail.com',
        subject: `Signed: ${booking.client_name}'s performance agreement`,
        text: `${booking.client_name} just signed the performance agreement for ${booking.event_title} on ${eventDateFormatted}.\n\nSigned PDF attached.`,
        attachments: [{ filename: 'Performance_Agreement_Signed.pdf', content: pdfBase64 }]
      })
    });

    // Update booking status in Supabase
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      },
      body: JSON.stringify({
        contract_status: 'signed',
        signed_name: printedName,
        signed_at: new Date().toISOString()
      })
    });

    // Update client status too
    if (booking.client_id) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/clients?id=eq.${booking.client_id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SECRET_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
          status: 'contract_signed',
          last_activity: new Date().toISOString()
        })
      });
    }

    res.status(200).json({ success: true });

  } catch(e) {
    console.error('sign-contract error:', e);
    res.status(500).json({ error: e.message });
  }
}
