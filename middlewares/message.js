/**
 * Единый обработчик входящих сообщений.
 * Приоритизирует сценарии: оператор, заказ, резерв, отзыв.
 * Если ни один сценарий не активен, просит использовать меню.
 */
const { operatorChatUsers, handleOperatorMessage } = require("./operatorChat");
const { userStates, handleOrderStep } = require("./orderHandler");
const { userReserveStates, handleReserveStep } = require("./reserveHandler");
const { userFeedbackStates, handleFeedbackStep } = require("../handlers/feedbackHandler");

function registerMessageHandler(bot) {
  bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message?.text || "";

    // Системные команды обрабатываются Telegraf отдельно
    if (text.startsWith("/")) return;

    if (operatorChatUsers.get(userId)) {
      await handleOperatorMessage(ctx);
      return;
    }

    if (userStates.has(userId)) {
      await handleOrderStep(ctx);
      return;
    }

    if (userReserveStates.has(userId)) {
      await handleReserveStep(ctx);
      return;
    }

    if (userFeedbackStates.has(userId)) {
      await handleFeedbackStep(ctx);
      return;
    }

    await ctx.reply("Пожалуйста, воспользуйтесь меню ниже.");
  });
}

module.exports = { registerMessageHandler };
