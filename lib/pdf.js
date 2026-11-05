'use strict';

const path = require('path');
const pdfmake = require('pdfmake');

const FONT_DIR = path.join(
  path.dirname(require.resolve('pdfmake/package.json')),
  'build',
  'fonts',
  'Roboto'
);

pdfmake.addFonts({
  Roboto: {
    normal: path.join(FONT_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(FONT_DIR, 'Roboto-Medium.ttf'),
    italics: path.join(FONT_DIR, 'Roboto-Italic.ttf'),
    bolditalics: path.join(FONT_DIR, 'Roboto-MediumItalic.ttf'),
  },
});
// We only read the bundled font files — allow local file access,
// and deny all external URL fetches (our documents contain none).
pdfmake.setLocalAccessPolicy(() => true);
pdfmake.setUrlAccessPolicy(() => false);

// Palette
const C = {
  ink: '#1a1a1a',
  muted: '#6b7280',
  accent: '#1f4e79',
  accentLight: '#eaf1f8',
  rule: '#d1d5db',
  tableHead: '#1f4e79',
};

const MARGIN = [0, 0, 0, 0];

/** Small section heading with a colored rule underneath. */
function sectionHeading(text) {
  return {
    stack: [
      { text: text.toUpperCase(), style: 'section', margin: [0, 14, 0, 2] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: C.accent }] },
    ],
    margin: [0, 0, 0, 6],
  };
}

/**
 * Build a pdfmake document definition from the normalized AI result.
 * @param {object} data - normalized result from lib/parse.js
 * @param {object} opts - { generatedAt }
 */
function buildDoc(data, opts = {}) {
  const content = [];

  // ---- Header ----
  content.push({
    text: data.title || 'Meeting Notes',
    style: 'title',
    margin: [0, 0, 0, 4],
  });

  const metaBits = [];
  if (data.date) metaBits.push(data.date);
  if (data.attendees?.length) metaBits.push('Attendees: ' + data.attendees.join(', '));
  if (metaBits.length) {
    content.push({ text: metaBits.join('  •  '), style: 'meta', margin: [0, 0, 0, 2] });
  }
  content.push({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: C.accent }],
    margin: [0, 6, 0, 8],
  });

  // ---- Summary ----
  if (data.summary) {
    content.push(sectionHeading('Summary'));
    content.push({
      text: data.summary,
      style: 'body',
      margin: [0, 0, 0, 4],
    });
  }

  // ---- Decisions ----
  if (data.decisions?.length) {
    content.push(sectionHeading('Key Decisions'));
    content.push(
      data.decisions.map((d, i) => ({
        text: [
          { text: `${i + 1}.  `, style: 'numBullet', bold: true },
          { text: d, style: 'body' },
        ],
        margin: [0, 0, 0, 4],
      }))
    );
  }

  // ---- Action items table ----
  if (data.action_items?.length) {
    content.push(sectionHeading('Action Items'));
    const hasOwner = data.action_items.some((a) => a.owner);
    const hasDue = data.action_items.some((a) => a.due);

    const headRow = ['#', 'Task'];
    if (hasOwner) headRow.push('Owner');
    if (hasDue) headRow.push('Due');

    const widths = [24, hasOwner ? (hasDue ? 305 : 400) : hasDue ? 420 : 445];
    if (hasOwner) widths.push(hasDue ? 90 : 105);
    if (hasDue) widths.push(hasOwner ? 76 : 91);

    const tableBody = [
      headRow.map((h) => ({
        text: h,
        style: 'tableHead',
        fillColor: C.tableHead,
        color: '#ffffff',
      })),
    ];

    data.action_items.forEach((a, i) => {
      const row = [{ text: String(i + 1), style: 'tableCell', color: C.muted }, { text: a.task, style: 'tableCell' }];
      if (hasOwner) row.push({ text: a.owner || '—', style: 'tableCell', color: a.owner ? C.ink : C.muted });
      if (hasDue) row.push({ text: a.due || '—', style: 'tableCell', color: a.due ? C.ink : C.muted });
      tableBody.push(row);
    });

    content.push({
      table: { headerRows: 1, widths, body: tableBody },
      layout: {
        hLineColor: () => C.rule,
        vLineColor: () => C.rule,
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        fillColor: (i) => (i % 2 === 1 ? '#f7f9fb' : null),
        paddingTop: () => 5,
        paddingBottom: () => 5,
        paddingLeft: () => 6,
        paddingRight: () => 6,
      },
      margin: [0, 0, 0, 4],
    });
  }

  // ---- Discussion topics ----
  if (data.topics?.length) {
    content.push(sectionHeading('Discussion Topics'));
    const blocks = [];
    data.topics.forEach((t) => {
      if (t.heading) {
        blocks.push({ text: t.heading, style: 'topicHead', margin: [0, t === data.topics[0] ? 0 : 6, 0, 2] });
      }
      if (t.points?.length) {
        blocks.push({
          ul: t.points.map((p) => ({ text: p, style: 'body' })),
          margin: [0, 0, 0, 2],
        });
      }
    });
    content.push({ stack: blocks, margin: [0, 0, 0, 4] });
  }

  // ---- Open questions ----
  if (data.open_questions?.length) {
    content.push(sectionHeading('Open Questions & Next Steps'));
    content.push({
      ol: data.open_questions.map((q) => ({ text: q, style: 'body' })),
      margin: [0, 0, 0, 4],
    });
  }

  // ---- Footer note ----
  content.push({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: C.rule }],
    margin: [0, 16, 0, 4],
  });
  content.push({
    text: opts.generatedAt
      ? `Generated from meeting notes • ${opts.generatedAt}`
      : 'Generated from meeting notes',
    style: 'footer',
  });

  return {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: 'Roboto', fontSize: 10.5, color: C.ink },
    info: {
      title: data.title || 'Meeting Notes',
      creator: 'meeting-to-pdf',
    },
    styles: {
      title: { fontSize: 22, bold: true, color: C.accent },
      meta: { fontSize: 9.5, color: C.muted },
      section: { fontSize: 11, bold: true, color: C.accent, letterSpacing: 1.2 },
      body: { fontSize: 10.5, color: C.ink, lineHeight: 1.35 },
      numBullet: { fontSize: 10.5, color: C.accent },
      topicHead: { fontSize: 10.5, bold: true, color: C.ink },
      tableHead: { fontSize: 9.5, bold: true },
      tableCell: { fontSize: 9.5 },
      footer: { fontSize: 8, color: C.muted, alignment: 'center' },
    },
    content,
  };
}

/** Render the doc definition to a Buffer. */
async function renderToBuffer(docDef) {
  const doc = pdfmake.createPdf(docDef);
  return await doc.getBuffer();
}

module.exports = { buildDoc, renderToBuffer };
