'use strict';

/**
 * Validate and normalize the JSON the model returned.
 * Tolerant of minor shape issues; returns a guaranteed-shape object.
 */
function normalize(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      // try to salvage a JSON object embedded in prose
      const match = obj.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Model response is not valid JSON');
      obj = JSON.parse(match[0]);
    }
  }
  if (!obj || typeof obj !== 'object') throw new Error('Model response is not an object');

  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const strArr = (v) => arr(v).map(str).filter(Boolean);

  const actionItems = arr(obj.action_items)
    .map((item) => {
      if (typeof item === 'string') return { task: item, owner: '', due: '' };
      return {
        task: str(item?.task),
        owner: str(item?.owner),
        due: str(item?.due ?? item?.deadline ?? item?.due_date),
      };
    })
    .filter((item) => item.task);

  const topics = arr(obj.topics)
    .map((t) => {
      if (typeof t === 'string') return { heading: '', points: [t] };
      return { heading: str(t?.heading ?? t?.title), points: strArr(t?.points ?? t?.items) };
    })
    .filter((t) => t.heading || t.points.length);

  const result = {
    title: str(obj.title),
    date: str(obj.date),
    attendees: strArr(obj.attendees ?? obj.attendee ?? obj.participants),
    summary: str(obj.summary),
    decisions: strArr(obj.decisions ?? obj.key_decisions),
    action_items: actionItems,
    topics,
    open_questions: strArr(obj.open_questions ?? obj.questions ?? obj.next_steps),
  };

  const hasContent =
    result.summary ||
    result.decisions.length ||
    result.action_items.length ||
    result.topics.length ||
    result.open_questions.length;

  if (!hasContent) throw new Error('Model returned an empty result');
  return result;
}

module.exports = { normalize };
