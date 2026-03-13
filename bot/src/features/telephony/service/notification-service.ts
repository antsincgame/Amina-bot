import { config } from '../../../config/index.js';
import { aiLogger } from '../../../config/logger.js';

export async function sendTelephonyOwnerMessage(
  ownerTelegramId: string,
  text: string,
): Promise<void> {
  if (!config.telegram.token || !ownerTelegramId) {
    return;
  }

  await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ownerTelegramId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  }).catch((error) => {
    aiLogger.warn({ error, ownerTelegramId }, '[Telephony] Failed to notify owner');
  });
}
