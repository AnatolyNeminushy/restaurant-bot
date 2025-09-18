/**
 * Обработчик сценария бронирования столов.
 * Хранит временное состояние пользователя, валидирует ввод и
 * отправляет готовую заявку в служебный чат.
 */
// reserveHandler.js
const { userStates } = require("./orderHandler");
/**
 * Состояния пользователей, проходящих мастер бронирования.
 * Ключ — userId, значение — объект с текущим шагом и введёнными данными.
 */
const userReserveStates = new Map();
const reserveGroupId = process.env.GROUP_ORDER_RES || "ID_ГРУППЫ";
const pool = require("../server/db");

/** ========= Утилиты ========= */
/**
 * Завершает сценарий бронирования и очищает временное состояние.
 */
function endReservation(userId) {
  userReserveStates.delete(userId);
}
/**
 * Принудительно завершает мастер и уведомляет пользователя,
 * например, при превышении лимита или по кнопке отмены.
 */
async function cancelReservation(ctx, reason = "Сессия бронирования завершена.") {
  const uid = ctx.from?.id;
  if (userReserveStates.has(uid)) {
    endReservation(uid);
    await ctx.reply(`❌ ${reason}`);
  }
}

/** ========= Старт ========= */
/**
 * Инициализирует мастер бронирования для пользователя.
 */
function startReservation(ctx, userId) {
  if (userStates && typeof userStates.delete === "function") {
    userStates.delete(userId);
  }
  userReserveStates.set(userId, { step: "name" });
  ctx.reply("📝 Как вас зовут?");
}

/** ========= Шаговик ========= */
/**
 * Обрабатывает текстовые сообщения в сценарии бронирования.
 * Возвращает true, если сообщение было обработано.
 */
async function handleReserveStep(ctx) {
  const userId = ctx.from.id;
  if (!userReserveStates.has(userId)) return false;

  const state = userReserveStates.get(userId);
  const text = (ctx.message?.text || "").trim();

  switch (state.step) {
    case "name":
      state.name = text;
      state.step = "phone";
      await ctx.reply("📞 Ваш номер телефона (например, 79999999999):");
      break;

    case "phone":
      if (!/^7\d{10}$/.test(text)) {
        await ctx.reply("❌ Введите телефон в формате 79999999999");
        return true;
      }
      state.phone = text;
      state.step = "address";
      await ctx.reply("🏢 Выберите ресторан для брони:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "ул. Баранова, 87", callback_data: "reserve_address_1" }],
            [{ text: "ул. Петрова, 27а", callback_data: "reserve_address_2" }],
            [{ text: "ул. Красная, 140", callback_data: "reserve_address_3" }],
          ],
        },
      });
      break;

    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        await ctx.reply(
          "❌ Введите дату в формате ГГГГ-ММ-ДД (например, 2025-07-13):",
          { reply_markup: { inline_keyboard: getNext7DaysKeyboard() } }
        );
        return true;
      }
      state.date = text;
      state.step = "guests";
      await ctx.reply("👥 На сколько человек столик?");
      break;

    case "guests":
      if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > 30) {
        await ctx.reply("❌ Введите число гостей (например, 2):");
        return true;
      }
      state.guests = text;
      state.step = "time";
      await ctx.reply("⏰ К какому времени подойти? (например, 18:00)");
      break;

    case "time":
      state.time = text;
      state.step = "comment";
      await ctx.reply("💬 Оставьте комментарий для администратора (или напишите “нет”):");
      break;

    case "comment":
      state.comment = text;
      await finalizeReservation(ctx, state);
      endReservation(userId);
      break;
  }

  if (userReserveStates.has(userId)) {
    userReserveStates.set(userId, state);
  }
  return true;
}

/** ========= Даты ========= */
/**
 * Формирует клавиатуру с ближайшими семью датами.
 */
function getNext7DaysKeyboard() {
  const days = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const label = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    const value = d.toISOString().split("T")[0];
    days.push([{ text: label, callback_data: `reserve_date_${value}` }]);
  }
  return days;
}

/** ========= Финализация ========= */
/**
 * Сохраняет бронь, отправляет её в чат и предлагает оставить отзыв.
 */
async function finalizeReservation(ctx, state) {
  const tgUser = ctx.from.username ? `@${ctx.from.username}` : `ID: ${ctx.from.id}`;

  let message = `📅 *Новая бронь столика с Telegram* (${tgUser})\n\n`;
  message += `👤 *Имя:* ${state.name}\n`;
  message += `📞 *Телефон:* +${state.phone}\n`;
  message += `🏢 *Адрес ресторана:* ${state.address}\n`;
  message += `📆 *Дата:* ${state.date}\n`;
  message += `👥 *Гостей:* ${state.guests}\n`;
  message += `⏰ *Время:* ${state.time}\n`;
  if (state.comment && state.comment.toLowerCase() !== "нет") {
    message += `💬 *Комментарий:* ${state.comment}\n`;
  }

  try {
    await ctx.reply(`✅ Ваша бронь отправлена!\n\n${message}\n\nОжидайте подтверждения.`, { parse_mode: "Markdown" });
    await ctx.telegram.sendMessage(reserveGroupId, message, { parse_mode: "Markdown" });

    await pool.query(
      `INSERT INTO reservations (
        tg_username, name, phone, address, date, time, guests, comment, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [
        ctx.from.username || null,
        state.name,
        state.phone,
        state.address,
        state.date,
        state.time,
        state.guests,
        state.comment || null,
      ]
    );
  } catch (err) {
    console.error("Ошибка отправки брони в группу или БД:", err);
    await ctx.reply("⚠️ Ошибка бронирования. Попробуйте позже или обратитесь к администратору.");
  }
}

/** ========= Глобальный гард ========= */
// Поставь ЭТО самым первым middleware
/**
 * Добавляет middleware, который отмечает вход в мастер бронирования.
 */
function attachReservationGuard(bot) {
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !userReserveStates.has(userId)) {
      return next();
    }

    // 1) Чужой callback => выходим из брони и пропускаем дальше
    if (ctx.updateType === "callback_query") {
      const data = ctx.callbackQuery?.data || "";
      if (!data.startsWith("reserve_")) {
        endReservation(userId);
        ctx.state = ctx.state || {};
        ctx.state.__reserve_exited = "callback";
        await ctx.answerCbQuery().catch(() => {});
        return next(); // позволяем чужому обработчику выполниться
      }
      return next(); // наш reserve_* — обработают action-хендлеры брони
    }

    // 2) Любая команда => мгновенно выходим и даём команде выполниться
    if (ctx.message?.text?.startsWith("/")) {
      endReservation(userId);
      ctx.state = ctx.state || {};
      ctx.state.__reserve_exited = "command";
      return next(); // НЕ блокируем, чтобы команда сработала сразу
    }

    // 3) Обычный текст — отдаём шаговику
    const handled = await handleReserveStep(ctx);

    if (handled) {
      // Шаг обработан — "съедаем" апдейт, дальше не пускаем
      return;
    }

    // Шаг не обработан (чужой текст) — закрываем сессию и пропускаем дальше
    endReservation(userId);
    ctx.state = ctx.state || {};
    ctx.state.__reserve_exited = "text";
    return next();
  });
}


/**
 * Помечаем апдейт после выхода из брони (для логгеров).
 * ⚠️ Больше НИЧЕГО не блокируем, чтобы команды/кнопки выполнялись сразу.
 */
/**
 * Middleware, фиксирующий выход пользователя из сценария бронирования.
 */
function markReserveExitForLoggers(bot) {
  bot.use(async (ctx, next) => {
    if (ctx.state?.__reserve_exited) {
      // для ваших логгеров смотрите на флаги:
      // __reserve_exited: 'command' | 'callback' | 'text'
      // можно также поставить ctx.state.__suppressReserveLogging = true;
      ctx.state.__suppressReserveLogging = true;
    }
    return next();
  });
}

/** ========= Регистрация ========= */
/**
 * Регистрирует все callback-действия и команды мастера бронирования.
 */
function registerReserveHandler(bot) {
  attachReservationGuard(bot);     // первым
  markReserveExitForLoggers(bot);  // сразу после — не блокирует цепочку

  // (Опционально) команды явного выхода
  bot.command(["cancel_reserve", "reserve_exit"], async (ctx) => {
    await cancelReservation(ctx, "Вы вышли из бронирования.");
  });

  // Адрес
  bot.action(/^reserve_address_(\d)$/, async (ctx) => {
    const userId = ctx.from.id;
    const state = userReserveStates.get(userId);
    if (!state) return;

    const map = {
      1: "ул. Баранова, 87",
      2: "ул. Петрова, 27а",
      3: "ул. Красная, 140",
    };

    state.address = map[ctx.match[1]];
    state.step = "date";
    await ctx.answerCbQuery();
    await ctx.reply(
      "📆 На какую дату бронируем?\n\nВыберите дату кнопкой или введите вручную в формате ГГГГ-ММ-ДД:",
      { reply_markup: { inline_keyboard: getNext7DaysKeyboard() } }
    );
    if (userReserveStates.has(userId)) userReserveStates.set(userId, state);
  });

  // Дата
  bot.action(/^reserve_date_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from.id;
    const state = userReserveStates.get(userId);
    if (!state) return;

    state.date = ctx.match[1];
    state.step = "guests";
    await ctx.answerCbQuery();
    await ctx.reply("👥 На сколько человек столик?");
    if (userReserveStates.has(userId)) userReserveStates.set(userId, state);
  });
}

module.exports = {
  userReserveStates,
  startReservation,
  handleReserveStep,
  registerReserveHandler,
  attachReservationGuard,
  markReserveExitForLoggers,
};
