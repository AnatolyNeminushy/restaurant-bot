const userFeedbackStates = new Map();
const feedbackGroupId = process.env.FEEDBACK_GROUP;

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

async function handleFeedbackMessage(ctx) {
  const userId = ctx.from.id;
  if (!userFeedbackStates.has(userId)) return false;
  if (!ctx.message || !ctx.message.text) return true;

  const text = ctx.message.text.trim();
  if (!text) return true;

  try {
    const author = ctx.from.username ? "@" + ctx.from.username : String(ctx.from.id);
    const messageLines = [
      "📝 *Новый отзыв о боте*",
      "",
      "🙋 " + author,
      "",
      text,
    ];
    const message = messageLines.join("\n");

    await ctx.telegram.sendMessage(feedbackGroupId, message, { parse_mode: "Markdown" });
    await ctx.reply("Спасибо за отзыв! 🙏 Нам очень важно ваше мнение.");
  } catch (err) {
    await ctx.reply("⚠️ Не удалось отправить отзыв. Попробуйте позже.");
  }

  userFeedbackStates.delete(userId);
  return true;
}

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
