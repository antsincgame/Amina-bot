/**
 * Telegram Keyboard Builders
 *
 * Все повторяющиеся клавиатуры собраны в одном месте.
 * Дизайн: дружелюбный, с крупными иконками, понятный для детей.
 */

import { InlineKeyboard, Keyboard } from 'grammy';
import { getMiniAppUrl } from './mini-app.js';

// ============================================
// Main Menu & Reply Keyboard
// ============================================

/** Главное inline-меню — яркое и дружелюбное для детей */
export const buildMainMenu = (): InlineKeyboard => {
  const mini = getMiniAppUrl();
  const menu = new InlineKeyboard();

  if (mini) {
    menu.webApp('✨ Открыть Амину ✨', mini).row();
  }

  return menu
    .text('🔍 Поиск', 'menu_search')
    .text('🖼️ Картинка', 'menu_imagine')
    .row()
    .text('🎤 Озвучить', 'menu_voice')
    .text('🎨 Фото-магия', 'edit_image_help')
    .row()
    .text('📝 Заметки', 'menu_notes')
    .text('✅ Задачи', 'menu_todos')
    .row()
    .text('⏰ Напоминания', 'menu_reminders')
    .text('🌅 Дайджест', 'menu_digest')
    .row()
    .text('⚡ Дайджест сейчас', 'digest_now')
    .text('📞 Телефония', 'menu_telephony')
    .row()
    .text('💡 Все команды', 'menu_help');
};

/**
 * Постоянная клавиатура (ReplyKeyboard) снизу чата.
 * Кнопки крупные, с иконками — удобно на телефоне и понятно для детей.
 */
export const buildReplyKeyboard = (): Keyboard =>
  new Keyboard()
    .text('🔍 Поиск').text('🖼️ Картинка')
    .row()
    .text('📝 Заметки').text('✅ Задачи')
    .row()
    .text('⏰ Напоминания').text('🌅 Дайджест')
    .row()
    .text('⚡ Дайджест сейчас').text('🎤 Озвучить')
    .row()
    .text('🎨 Фото-магия').text('📞 Телефония')
    .row()
    .text('🎛️ Меню')
    .resized()
    .persistent();

// ============================================
// Feature-specific Keyboards (deduplicated)
// ============================================

/** Кнопка "Все заметки" */
export const notesListKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text('📋 Все заметки', 'notes_list');

/** Кнопка "Все задачи" */
export const todosListKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text('📋 Все задачи', 'todos_list');

/** Кнопки "✅ 1", "✅ 2" ... для выполнения задач */
export const todoDoneKeyboard = (count: number, maxButtons = 5): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  const max = Math.min(count, maxButtons);
  for (let i = 1; i <= max; i++) {
    keyboard.text(`✅ ${i}`, `todo_done_${i}`);
  }
  return keyboard;
};

/** Кнопки дайджеста (вкл/выкл + сейчас + настройки) */
export const digestControlsKeyboard = (enabled: boolean): InlineKeyboard =>
  new InlineKeyboard()
    .text(enabled ? '🔕 Выключить' : '🔔 Включить', 'digest_toggle')
    .text('🔄 Сейчас', 'digest_now')
    .row()
    .text('🏙️ Город', 'digest_city_help')
    .text('🕐 Время', 'digest_time_help')
    .row()
    .text('📰 AI-обзор новостей', 'news_curate');

/** Кнопка вкл/выкл дайджеста */
export const digestToggleKeyboard = (enabled: boolean): InlineKeyboard =>
  new InlineKeyboard().text(enabled ? '🔕 Выключить' : '🔔 Включить', 'digest_toggle');

/** Кнопки под ответом AI (сохранить/озвучить/меню) */
export const responseActionsKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('📌 Заметка', 'save_to_notes')
    .text('🔊 Озвучить', 'read_aloud')
    .text('🎛️ Меню', 'show_menu');

/** Кнопки заметок (добавить + обновить) */
export const notesActionsKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('📌 Добавить', 'menu_note_help')
    .text('🔄 Обновить', 'menu_notes');

/** Кнопка "Обновить" для напоминаний */
export const remindersRefreshKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text('🔄 Обновить', 'menu_reminders');

/** Подсказка под сгенерированным изображением */
export const imageActionsKeyboard = (): InlineKeyboard =>
  new InlineKeyboard()
    .text('✏️ Как редактировать', 'edit_image_help');
