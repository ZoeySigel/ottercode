export type Draft = { text: string; cursor: number };
export type InputKey = { return?: boolean; meta?: boolean; shift?: boolean; ctrl?: boolean; backspace?: boolean; delete?: boolean; leftArrow?: boolean; rightArrow?: boolean; home?: boolean; end?: boolean };

export function insertDraft(draft: Draft, input: string): Draft {
  const characters = Array.from(draft.text);
  const inserted = Array.from(input.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
  characters.splice(draft.cursor, 0, ...inserted);
  return { text: characters.join(''), cursor: draft.cursor + inserted.length };
}

export function editDraft(draft: Draft, input: string, key: InputKey): Draft {
  const characters = Array.from(draft.text);
  if (key.return && (key.meta || key.shift)) return insertDraft(draft, '\n');
  if (key.ctrl && input === 'a' || key.home) return { ...draft, cursor: 0 };
  if (key.ctrl && input === 'e' || key.end) return { ...draft, cursor: characters.length };
  if (key.ctrl && input === 'u') return { text: characters.slice(draft.cursor).join(''), cursor: 0 };
  if (key.leftArrow) return { ...draft, cursor: Math.max(0, draft.cursor - 1) };
  if (key.rightArrow) return { ...draft, cursor: Math.min(characters.length, draft.cursor + 1) };
  if (key.backspace && draft.cursor > 0) { characters.splice(draft.cursor - 1, 1); return { text: characters.join(''), cursor: draft.cursor - 1 }; }
  if (key.delete) { characters.splice(draft.cursor, 1); return { text: characters.join(''), cursor: draft.cursor }; }
  if (!key.ctrl && !key.meta && input && !key.return) return insertDraft(draft, input);
  return draft;
}
