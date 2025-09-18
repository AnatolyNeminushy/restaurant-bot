const { startOperatorChat } = require("../middlewares/operatorChat");

/**
 * Отдельный модуль, который отвечает за быстрый выход на оператора
 * (как из команд, так и из inline-кнопок).
 */
module.exports = function registerOperatorHandler(bot) {
  /**
   * Единый шаблон ответа пользователю.
   */
  const notify = async (ctx) => {
    await ctx.reply("💬 Вы в чате с оператором. Напишите вопрос — мы на связи.");
  };

  /**
   * Обработка inline-кнопки «Связаться с оператором».
   */
  bot.action("start_operator_chat", async (ctx) => {
    const userId = ctx.from.id;
    startOperatorChat(userId);
    await ctx.answerCbQuery("Подключаем оператора");
    await notify(ctx);
  });

  /**
   * Команда /operator — альтернативный путь для тех, кто привык к текстовым командам.
   */
  bot.command("operator", async (ctx) => {
    const userId = ctx.from.id;
    startOperatorChat(userId);
    await notify(ctx);
  });
};
