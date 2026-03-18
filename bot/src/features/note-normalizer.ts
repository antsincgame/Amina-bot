export type NoteInputSource =
  | 'callback_save_to_notes'
  | 'callback_save_to_notes_full'
  | 'command_note'
  | 'awaiting_note'
  | 'auto_detect';

export interface NormalizedNoteInput {
  content: string;
  source: NoteInputSource;
  rawLength: number;
  normalizedLength: number;
}

function cleanAiStyledNote(content: string): string {
  return content
    .replace(/[Зз]аметка\s+создана[:\s]*["«'"](.+?)["»'"]/s, '$1')
    .replace(/(?:просил[аи]?\s+)?создать\s+заметку\s+["«'"](.+?)["»'"]/i, '$1')
    .replace(/\n*📚\s*Источники?:[\s\S]*$/i, '')
    .replace(/\n*Источники?:\s*\n[\s\S]*$/i, '')
    .replace(/^(Конечно!?\s*)?Сейчас\s+(я\s+)?(найду|поищу|посмотрю)[^\n]*\n*/i, '')
    .replace(/^🔍?\s*Ищу[.…]{0,3}\s*\n*/gim, '')
    .replace(/\(Поиск в интернете\)\s*/gi, '')
    .replace(/^(привет|здравствуй(?:те)?)[,!\s]+/i, '')
    .replace(/\n*Хочешь узнать больше[\s\S]*$/i, '')
    .replace(/\n*Если (?:у тебя есть|хочешь)[\s\S]*$/i, '')
    .replace(/\n*Дай знать[\s\S]*$/i, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[(\d+)\]/g, '')
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanManualNote(content: string): string {
  return content
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeNoteInput(rawText: string, source: NoteInputSource): NormalizedNoteInput {
  const trimmed = rawText.trim();
  const cleaned = source === 'callback_save_to_notes' || source === 'callback_save_to_notes_full'
    ? cleanAiStyledNote(trimmed)
    : cleanManualNote(trimmed);

  return {
    content: cleaned.slice(0, 4000).trim(),
    source,
    rawLength: trimmed.length,
    normalizedLength: cleaned.length,
  };
}
