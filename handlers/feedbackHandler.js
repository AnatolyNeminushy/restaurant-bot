const userFeedbackStates = new Map(); // userId -> ожидаем текст отзыва
const feedbackGroupId = process.env.FEEDBACK_GROUP;

/**
 * Запускает сценарий сбора отзыва. Пользователь получает подсказку и кнопку отмены.
 */
function startFeedback(ctx, userId) {
  userFeedbackStates.set(userId, true);
  ctx.reply(
    "🤔 Нам важно мнение гостей! Напишите, что понравилось или нет в работе бота.\n\n" +
      "Если передумали — нажмите «Отмена».",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "✖ Отмена", callback_data: "cancel_feedback" }]],
      },
    }
  );
}

/**
 * Обрабатывает входящее сообщение пользователя как отзыв и пересылает его в служебный чат.
 */
async function handleFeedbackMessage(ctx) {
  const userId = ctx.from.id;
  if (!userFeedbackStates.has(userId)) return false; // это не отзыв, пропускаем на следующий middleware
  if (!ctx.message || !ctx.message.text) return true; // ничего не делаем, но обрабатываем событие

  const text = ctx.message.text.trim();
  if (!text) return true;

  try {
    const author = ctx.from.username ? "@" + ctx.from.username : String(ctx.from.id);
    const message = [
      "📝 *Новый отзыв о боте*",
      "",
      "🙋 " + author,
      "",
      text,
    ].join("\n");

    await ctx.telegram.sendMessage(feedbackGroupId, message, { parse_mode: "Markdown" });
    await ctx.reply("Спасибо за отзыв! 🙏 Нам очень важно ваше мнение.");
  } catch (err) {
    await ctx.reply("⚠️ Не удалось отправить отзыв. Попробуйте позже.");
  }

  userFeedbackStates.delete(userId);
  return true;
}

/**
 * Отклик на inline-кнопки во время сценария (сейчас поддерживаем только «Отмена»).
 */
async function handleFeedbackAction(ctx) {
  const userId = ctx.from.id;
  if (!userFeedbackStates.has(userId)) return false;

  const callback = ctx.callbackQuery?.data;
  if (callback === "cancel_feedback") {
    userFeedbackStates.delete(userId);
    await ctx.answerCbQuery("Отмена");
    await ctx.reply("Отзыв отменён. Если передумаете — напишите снова!");
    return true;
  }

  return false;
}

/** Регистрирует обработчики отзывов. */
function registerFeedbackHandler(bot) {
  bot.action("start_feedback", async (ctx) => {
    const userId = ctx.from.id;
    startFeedback(ctx, userId);
    await ctx.answerCbQuery();
  });

  bot.on("message", handleFeedbackMessage);
  bot.on("callback_query", handleFeedbackAction);
}

module.exports = {
  startFeedback,
  handleFeedbackMessage,
  handleFeedbackAction,
  registerFeedbackHandler,
};
