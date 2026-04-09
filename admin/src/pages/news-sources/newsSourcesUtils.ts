import type { JsonFieldMapping, HtmlFieldMapping } from '../../../../shared/types/index.js';

export const formatJsonBlock = (value?: JsonFieldMapping | HtmlFieldMapping): string =>
  value ? JSON.stringify(value, null, 2) : '';

export const parseJsonBlock = <T extends object>(raw: string, label: string): T | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`Поле "${label}" должно содержать валидный JSON`);
  }
};
