/**
 * Загрузка переменных окружения и экспорт ключевых значений.
 */
require('dotenv').config();

module.exports = {
  /** Telegram Bot API token */
  BOT_TOKEN: process.env.BOT_TOKEN,
  /** API ключ для OpenAI (используется оператором) */
  AI_API_KEY: process.env.AI_API_KEY,
  /** ID группы для уведомлений о заказах */
  GROUP_ORDER: process.env.GROUP_ORDER,
};
