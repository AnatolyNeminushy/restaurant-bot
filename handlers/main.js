const { Markup } = require("telegraf");
const { getCategoryKeyboard } = require("../utils/keyboards");
const { startOperatorChat } = require("../middlewares/operatorChat");
const { startReservation } = require("../middlewares/reserveHandler");

/**
 * Регистрирует приветственный сценарий и базовые действия главного меню.
 * Здесь собраны UX-точки, куда пользователь попадает сразу после /start.
 */
module.exports = function registerMainHandlers(bot) {
  /**
   * Приветственное сообщение с основными кнопками.
   *  Предлагаем посмотреть короткое видео, чтобы снизить нагрузку на операторов.
   */
  bot.start(async (ctx) => {
    await ctx.reply(
      [
        "👋 Привет! Я — бот сети \"Аями\". Чем могу помочь? 😊",
        "",
        "👉 Перед первым заказом советуем короткое видео — так быстрее разобраться с корзиной и оформлением.",
        "🧾 Используя бота, ты соглашаешься с политикой обработки данных:",
        "https://sushi-ayami.ru/policy",
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("🍣 Хочу заказать еду", "button_food_clicked")],
        [Markup.button.callback("💬 Связаться с оператором", "start_operator_chat")],
        [Markup.button.callback("📅 Забронировать стол", "reserve_table")],
        [Markup.button.callback("🎬 Смотреть инструкцию", "show_video")],
      ])
    );
  });

  /**
   * Ссылка на видеоинструкцию — часто используемый путь для новых гостей.
   */
  bot.action("show_video", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("👀 Вот короткое видео. Если останутся вопросы — жми на оператора!");
    await ctx.reply("https://t.me/instruction_bot_01");
  });

  /**
   * Старт общения с оператором из inline-кнопки.
   */
  bot.action("start_operator_chat", async (ctx) => {
    const userId = ctx.from.id;
    startOperatorChat(userId);

    await ctx.answerCbQuery("Связываем с оператором");
    await ctx.reply("💬 Вы в чате с оператором. Напишите свой вопрос, он придёт живому сотруднику.");
  });

  /**
   * Разворачиваем меню категорий.
   */
  bot.action("button_food_clicked", async (ctx) => {
    try {
      const message = ctx.update.callback_query.message;
      const keyboard = Markup.inlineKeyboard([
        ...getCategoryKeyboard().reply_markup.inline_keyboard,
        [Markup.button.callback("💬 Связаться с оператором", "start_operator_chat")],
      ]);

      if (message.photo) {
        await ctx.deleteMessage();
        await ctx.reply("Выберите раздел меню:", keyboard);
      } else {
        await ctx.editMessageText("Выберите раздел меню:", keyboard);
      }

      await ctx.answerCbQuery();
    } catch (err) {
      console.error("Ошибка button_food_clicked:", err);
      await ctx.answerCbQuery("Не удалось открыть меню", { show_alert: true });
    }
  });

  /**
   * Запуск мастера бронирования стола.
   */
  bot.action("reserve_table", async (ctx) => {
    const userId = ctx.from.id;
    await startReservation(ctx, userId);
  });
};
