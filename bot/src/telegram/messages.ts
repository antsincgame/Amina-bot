/**
 * Telegram Message Handlers — thin re-export module.
 * Actual implementations are in ./handlers/ directory.
 */
export {
  setupMessageHandlers,
  handleTextMessage,
  handleVoiceMessage,
  handlePhotoMessage,
  handleDocumentMessage,
  downloadTelegramPhoto,
  handleImageEdit,
} from './handlers/index.js';
