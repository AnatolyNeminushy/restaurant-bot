// Клавиатуры для Telegram-бота
const { Markup } = require("telegraf");
const categoryMap = require("../data/categoryMap");

/**
 * Собирает инлайн-клавиатуру с категориями меню.
 */
function getCategoryKeyboard() {
  const buttons = [];

  for (const [key, val] of Object.entries(categoryMap)) {
    let title;
    let cbData;

    if (typeof val === "object" && val && typeof val.title === "string") {
      // Объект категории: берём заголовок из поля title и отдельные ключи для колбэка.
      title = val.title.trim();
      // Нестандартные названия колбэков для нужд бизнес-логики.
      if (key === "rolls") cbData = "category_rolls";
      else if (key === "biznes_lunch") cbData = "category_biznes_lunch";
      else cbData = `category_${key}`;
    } else if (typeof val === "string") {
      // Простая строка: используем её как заголовок и формируем колбэк по ключу.
      title = val.trim();
      cbData = `category_${key}`;
    } else {
      continue; // Пропускаем некорректные записи.
    }

    if (!title) continue;
    buttons.push(Markup.button.callback(title, cbData));
  }

  // Разбиваем список кнопок по две в строке.
  const rows = [];
  const perRow = 2;
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }

  return Markup.inlineKeyboard(rows);
}

module.exports = { getCategoryKeyboard };
