// api/invoice.js
// CommonJS — works without "type":"module" in package.json
// POST { action: 'generate', ...invoiceData } → { pdf: base64, filename }
// POST { action: 'send', invoiceData, toEmail, toName, customMessage? } → { success }

const { Resend }     = require('resend');
const PDFDocument    = require('pdfkit');
const fs             = require('fs');
const path           = require('path');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  if (action === 'generate') {
    try {
      const buf      = await buildInvoicePDF(req.body);
      const filename = safeFilename(req.body);
      return res.status(200).json({ pdf: buf.toString('base64'), filename });
    } catch (err) {
      console.error('invoice generate error:', err);
      return res.status(500).json({ error: err.message });
    }

  } else if (action === 'send') {
    const { invoiceData, toEmail, toName, customMessage } = req.body;
    if (!invoiceData || !toEmail)
      return res.status(400).json({ error: 'Missing invoiceData or toEmail' });
    try {
      const resend     = new Resend(process.env.RESEND_KEY);
      const buf        = await buildInvoicePDF(invoiceData);
      const filename   = safeFilename(invoiceData);
      const dep        = invoiceData.depositPercent || 50;
      const depAmt     = Math.round((invoiceData.total || 0) * dep / 100).toLocaleString();
      const body       = customMessage ||
        `Please find your invoice attached for the ${invoiceData.eventName || 'upcoming event'}.\n\nA ${dep}% deposit ($${depAmt}) is required to secure your date — payment details are on page 2 of the invoice.\n\nLooking forward to an unforgettable performance!`;

      await resend.emails.send({
        from:    'Shine, The Mentalist <shine@texasmentalist.com>',
        to:      [toEmail],
        subject: `Invoice – ${invoiceData.eventName || 'Your Event'} | Shine, The Mentalist`,
        text:    `Hi ${toName || 'there'},\n\n${body}\n\n– Shine\ntexasmentalist.com`,
        html:    `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#1a1a2e">
          <div style="border-bottom:3px solid #B8960C;padding-bottom:16px;margin-bottom:24px">
            <h2 style="margin:0;font-size:22px">Shine, The Mentalist</h2>
            <a href="https://texasmentalist.com" style="color:#B8960C;font-size:13px;text-decoration:none">texasmentalist.com</a>
          </div>
          <p>Hi ${toName || 'there'},</p>
          ${body.split('\n').map(l => l ? `<p style="margin:6px 0">${l}</p>` : '<br>').join('')}
          <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
            Shine, The Mentalist &nbsp;|&nbsp; texasmentalist.com &nbsp;|&nbsp; 2020shine@gmail.com
          </div></div>`,
        attachments: [{ filename, content: buf.toString('base64') }],
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('invoice send error:', err);
      return res.status(500).json({ error: err.message });
    }

  } else {
    return res.status(400).json({ error: 'Invalid action. Use "generate" or "send".' });
  }
};

function safeFilename(data) {
  return 'Invoice_ShineTheMentalist_' +
    (data.clientCompany || data.clientName || 'Client').replace(/\s+/g, '_') + '.pdf';
}

function formatGuests(g) {
  if (!g) return '';
  var s = String(g).trim();
  // If it's a plain number or starts with a digit, prefix "Approximately"
  if (/^[0-9]/.test(s) && !/approx/i.test(s)) return 'Approximately ' + s + ' people';
  // If it already says "approximately" just ensure "people" at end
  if (/approx/i.test(s) && !/people/i.test(s)) return s + ' people';
  return s;
}

function formatTimeRange(startTime, duration) {
  if (!startTime) return '';
  var start12 = fmt12h(startTime);
  if (!duration) return start12;
  // Parse start time to minutes
  var m = String(startTime).match(/([0-9]{1,2}):([0-9]{2})/);
  if (!m) return start12;
  var startMins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  // Parse duration — supports "3 hours", "2.5 hours", "90 minutes", "1 hour 30 minutes"
  var durationMins = 0;
  var dStr = String(duration).toLowerCase();
  var hoursMatch = dStr.match(/([0-9.]+)\s*h/);
  var minsMatch  = dStr.match(/([0-9.]+)\s*m/);
  if (hoursMatch) durationMins += Math.round(parseFloat(hoursMatch[1]) * 60);
  if (minsMatch)  durationMins += parseInt(minsMatch[1], 10);
  if (durationMins === 0) return start12;
  var endMins = startMins + durationMins;
  var endH = Math.floor(endMins / 60) % 24;
  var endM = String(endMins % 60).padStart(2, '0');
  var endAmpm = endH >= 12 ? 'PM' : 'AM';
  endH = endH % 12 || 12;
  return start12 + ' – ' + endH + ':' + endM + ' ' + endAmpm;
}

function fmt12h(t) {
  if (!t) return '';
  const m = String(t).match(/([0-9]{1,2}):([0-9]{2})/);
  if (!m) return String(t);
  let h = parseInt(m[1], 10), min = m[2], ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + min + ' ' + ampm;
}

function buildInvoicePDF(data) {
  return new Promise(function(resolve, reject) {
    // Load logo
    var logoBuffer = null;
    try {
      var logoPath = path.join(process.cwd(), 'icons', 'logo.png');
      if (fs.existsSync(logoPath)) logoBuffer = fs.readFileSync(logoPath);
    } catch(e) {}

    var doc    = new PDFDocument({ margin: 50, size: 'LETTER' });
    var chunks = [];
    doc.on('data', function(c) { chunks.push(c); });
    doc.on('end',  function()  { resolve(Buffer.concat(chunks)); });
    doc.on('error', reject);

    var GOLD  = '#B8960C';
    var DARK  = '#1a1a2e';
    var GRAY  = '#6b7280';
    var LG    = '#f3f4f6';
    var WHITE = '#ffffff';

    // ── HEADER ────────────────────────────────────────────────────────────────
    if (logoBuffer) {
      doc.image(logoBuffer, 50, 36, { width: 62, height: 62 });
    }
    doc.font('Helvetica-Bold').fontSize(22).fillColor(DARK).text('Shine, The Mentalist', 122, 44);
    doc.font('Helvetica').fontSize(10).fillColor(GOLD).text('texasmentalist.com', 122, 71);
    doc.font('Helvetica-Bold').fontSize(28).fillColor(GOLD).text('INVOICE', 380, 44, { align:'right', width:182 });
    doc.moveTo(50,100).lineTo(562,100).lineWidth(2).strokeColor(GOLD).stroke();
    doc.moveTo(50,103).lineTo(562,103).lineWidth(0.5).strokeColor(DARK).stroke();

    // ── BILL TO / INVOICE META ────────────────────────────────────────────────
    var y = 122;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('BILL TO', 50, y);
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('INVOICE DETAILS', 350, y, { align:'right', width:212 });
    y += 13;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(data.clientCompany || data.clientName || '', 50, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text('Invoice #: ' + (data.invoiceNumber || ''), 350, y, { align:'right', width:212 });
    y += 15;
    if (data.contactName) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.contactName, 50, y);
    doc.font('Helvetica').fontSize(10).fillColor(DARK).text('Invoice Date: ' + (data.invoiceDate || ''), 350, y, { align:'right', width:212 });
    y += 14;
    if (data.clientCity) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientCity, 50, y);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text('Due Date: ' + (data.dueDate || ''), 350, y, { align:'right', width:212 });
    y += 14;
    if (data.clientPhone) doc.font('Helvetica').fontSize(10).fillColor(DARK).text(data.clientPhone, 50, y);

    // ── EVENT DETAILS ─────────────────────────────────────────────────────────
    y += 28;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('EVENT DETAILS', 50, y);
    y += 10;
    var eventRows = [
      ['Event',  data.eventName],
      ['Date',   data.eventDate],
      ['Time',   formatTimeRange(data.eventTime, data.duration)],
      ['Venue',  data.venue],
      ['Guests', formatGuests(data.guests)],
    ].filter(function(r) { return r[1]; });

    eventRows.forEach(function(row, i) {
      var ry = y + i * 22;
      doc.rect(50,ry,512,22).fillColor(i%2===0?LG:WHITE).fill();
      doc.rect(50,ry,512,22).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(row[0], 58, ry+6);
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(row[1], 200, ry+6);
    });

    // ── SERVICES TABLE ────────────────────────────────────────────────────────
    y += eventRows.length * 22 + 20;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('SERVICES', 50, y);
    y += 10;
    doc.rect(50,y,512,22).fillColor(DARK).fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(WHITE)
       .text('Description',58,y+6).text('Details',210,y+6)
       .text('Amount',468,y+6,{align:'right',width:86});
    y += 22;
    (data.lineItems || []).forEach(function(item) {
      var dh = doc.heightOfString(item.description||'',{width:140,fontSize:10});
      var th = doc.heightOfString(item.details||'',{width:240,fontSize:10});
      var rh = Math.max(dh,th)+16;
      doc.rect(50,y,512,rh).fillColor(WHITE).fill();
      doc.rect(50,y,512,rh).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text(item.description||'',58,y+8,{width:140});
      doc.font('Helvetica').fontSize(10).fillColor(DARK).text(item.details||'',210,y+8,{width:240});
      doc.font('Helvetica').fontSize(10).fillColor(DARK)
         .text('$'+Number(item.amount||0).toLocaleString(),468,y+8,{align:'right',width:86});
      y += rh;
    });

    // Total
    doc.rect(50,y,512,28).strokeColor(GOLD).lineWidth(1.5).stroke();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('TOTAL',350,y+8);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(GOLD)
       .text('$'+Number(data.total||0).toLocaleString(),468,y+8,{align:'right',width:86});
    y += 28;

    var dep    = data.depositPercent || 50;
    var depAmt = Math.round((data.total||0)*dep/100).toLocaleString();
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY)
       .text('* A '+dep+'% deposit ($'+depAmt+') is required to secure the date. Remaining balance due on or before '+(data.eventDate||'.')+'.',
             50, y+8, {width:512});
    y += 28;
    doc.moveTo(50,y+8).lineTo(562,y+8).lineWidth(1).strokeColor(GOLD).stroke();
    doc.moveTo(50,y+11).lineTo(562,y+11).lineWidth(0.3).strokeColor(DARK).stroke();

    // ── PAGE 2: 3-COLUMN PAYMENT INFO ────────────────────────────────────────
    doc.addPage();
    var col1=50, col2=230, col3=400, colW=160;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK)
       .text('Payment Methods',col1,60)
       .text('Payment Terms',  col2,60)
       .text('Questions?',     col3,60);

    [col1,col2,col3].forEach(function(x) {
      doc.moveTo(x,76).lineTo(x+colW,76).lineWidth(1).strokeColor(GOLD).stroke();
    });

    // Col 1 — Payment Methods. Lead with the check details an AP department needs
    // (exactly what to write on the cheque), then the digital options.
    var REMIT_ADDRESS = '';  // Shine's remit-to mailing address; set to print "Mail check to:"
    var remit = data.remitAddress || REMIT_ADDRESS;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text('Pay by check', col1, 88);
    doc.font('Helvetica').fontSize(9).fillColor(DARK).text('Pay to the order of:', col1, 101);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text('Shine Thankappan', col1, 112);
    doc.font('Helvetica').fontSize(9).fillColor(DARK).text('Memo: Invoice ' + (data.invoiceNumber || ''), col1, 125);
    var yc = 138;
    if (remit) {
      doc.font('Helvetica').fontSize(9).fillColor(DARK).text('Mail check to:', col1, yc); yc += 11;
      String(remit).split('\n').forEach(function (ln) { doc.font('Helvetica').fontSize(9).fillColor(DARK).text(ln, col1, yc); yc += 11; });
    }
    yc += 4;
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
       .text('Also: Zelle 2020shine@gmail.com  |  Venmo @Shine-Thankappan  |  PayPal shine_e_thankappan@yahoo.com  |  Cash',
             col1, yc, { width: colW });

    // Col 2 — Payment Terms
    doc.font('Helvetica').fontSize(9).fillColor(DARK)
       .text(dep+'% deposit due upon booking.',      col2,88)
       .text('Balance due on day of performance.',   col2,104)
       .text('Cancellation policy per agreement.',   col2,120);

    // Col 3 — Questions
    doc.font('Helvetica').fontSize(9).fillColor(DARK)
       .text('texasmentalist.com',  col3,88)
       .text('2020shine@gmail.com', col3,104)
       .text('+1 (612) 865-7681',   col3,120);

    doc.font('Helvetica').fontSize(10).fillColor(GRAY)
       .text('Thank you for choosing Shine, The Mentalist — looking forward to an unforgettable evening!',
             50,200,{align:'center',width:512});
    doc.moveTo(50,224).lineTo(562,224).lineWidth(1).strokeColor(GOLD).stroke();

    doc.end();
  });
}
