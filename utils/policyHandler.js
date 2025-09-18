// Обработчики политики конфиденциальности
const { Markup } = require("telegraf");

const POLICY_URL = "https://sushi-ayami.ru/policy";

/**
 * Регистрирует обработчики команды /policy.
 * @param {import("telegraf").Telegraf} bot
 */
function attachPolicyHandlers(bot) {
  // Подписываемся на команду /policy.
  bot.command("policy", async (ctx) => {
    // Отправляем текст политики и прикрепляем кнопку со ссылкой.
    await ctx.replyWithHTML(
      `<b>Политика обработки персональных данных</b>\n\n` +
        "Мы бережно храним ваши контакты и используем их только для оформления заказов (ничего лишнего и точно не передаем третьим лицам).\n\n" +
        `<a href="${POLICY_URL}">${POLICY_URL}</a>`,
      Markup.inlineKeyboard([
        Markup.button.url("Открыть политику", POLICY_URL),
      ])
    );
  });
}

module.exports = { attachPolicyHandlers };