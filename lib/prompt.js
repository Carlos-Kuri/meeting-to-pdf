'use strict';

// Shared prompt used by BOTH local (Ollama) and online providers.
// Kept short: with local models every prompt token costs real time.

const SYSTEM_PROMPT = `Organize raw meeting notes into JSON. Output ONLY this JSON shape, no other text:
{"title":"","date":"","attendees":[],"summary":"","decisions":[],"action_items":[{"task":"","owner":"","due":""}],"topics":[{"heading":"","points":[]}],"open_questions":[]}
Fill every section:
- decisions: each agreement, rejection or change the notes show being made.
- action_items: every task or commitment someone took on; copy owner/due exactly from the notes, else "".
- open_questions: questions raised but not answered in the notes.
- topics: group the discussion into 2-5 short headings; points are short phrases.
- summary: 2-3 sentences only.
Be terse: the whole answer must stay under 400 words. Never pad.
Use only what the notes say; never invent people, dates or decisions; empty array when none. Same language as the notes.`;

/** Short directive prepended to the user's notes — recent text gets more attention from small models. */
const USER_DIRECTIVE =
  'Put every agreement in decisions, every task with the responsible person in action_items, and unanswered questions in open_questions.\n\n';

function buildUserContent(notes, meta) {
  const parts = [];
  if (meta.title) parts.push(`Title: ${meta.title}`);
  if (meta.date) parts.push(`Date: ${meta.date}`);
  if (meta.attendees) parts.push(`Attendees: ${meta.attendees}`);
  parts.push(USER_DIRECTIVE + 'NOTES:\n' + notes);
  return parts.join('\n');
}

module.exports = { SYSTEM_PROMPT, USER_DIRECTIVE, buildUserContent };
