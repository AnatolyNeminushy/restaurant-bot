// orderHandler.js
const { userCarts, getCartTotal, clearCart } = require("../order_cart/cart");
const { startFeedback } = require("../handlers/feedbackHandler");
const { getMenu } = require("../data/menu");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc"); // обязателен для timezone
const timezone = require("dayjs/plugin/timezone");
const customParseFormat = require("dayjs/plugin/customParseFormat");
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const pool = require("../server/db");

const userStates = new Map();
const ordersGroupId = process.env.GROUP_ORDER_APPL;

/** ================== ВРЕМЯ / ЧАСЫ РАБОТЫ ================== */
const TZ = "Asia/Yekaterinburg";
const MIN_READY_MIN = 60; // полтора часа
const SLOT_MIN = 5; // округление до 5 минут

const OPEN_HOURS = {
  0: ["09:00", "23:00"], // Sunday
  1: ["09:00", "23:00"],
  2: ["09:00", "23:00"],
  3: ["09:00", "23:00"],
  4: ["09:00", "00:00"],
  5: ["09:00", "00:00"],
  6: ["09:00", "23:00"], // Saturday
};

// текущее локальное время в единой TZ
const now = () => dayjs().tz(TZ);

// парс строки во времени TZ
const tzParse = (str, fmt) => dayjs.tz(str, fmt, TZ);
const canPayByCard = (state) => state?.deliveryType === "Самовывоз";

// округление вверх до ближайших SLOT_MIN минут
function roundUpToSlot(d, slot = SLOT_MIN) {
  const m = d.minute();
  const r = Math.ceil(m / slot) * slot;
  return d.minute(r).second(0);
}

// прижимаем время к часам работы
function clampToOpenHours(d) {
  const dayIdx = d.day(); // 0..6
  const [start, end] = OPEN_HOURS[dayIdx];

  const open = tzParse(
    `${d.format("YYYY-MM-DD")} ${start}`,
    "YYYY-MM-DD HH:mm"
  );
  let close = tzParse(`${d.format("YYYY-MM-DD")} ${end}`, "YYYY-MM-DD HH:mm");
  if (end === "00:00") close = close.add(1, "day"); // закрытие после полуночи

  if (d.isBefore(open)) return open;
  if (d.isAfter(close)) {
    // перенос на завтра к открытию
    const next = d.add(1, "day");
    const [nStart] = OPEN_HOURS[next.day()];
    return tzParse(
      `${next.format("YYYY-MM-DD")} ${nStart}`,
      "YYYY-MM-DD HH:mm"
    );
  }
  return d;
}

// «как можно быстрее» = сейчас + 90 минут (с округлением и часами работы)
function getEarliestReady() {
  let t = now().add(MIN_READY_MIN, "minute");
  t = roundUpToSlot(t);
  t = clampToOpenHours(t);
  return t;
}

function isRestaurantOpenNow() {
  const t = now();
  const [start, end] = OPEN_HOURS[t.day()];
  const startTime = tzParse(
    `${t.format("YYYY-MM-DD")} ${start}`,
    "YYYY-MM-DD HH:mm"
  );
  let endTime = tzParse(`${t.format("YYYY-MM-DD")} ${end}`, "YYYY-MM-DD HH:mm");
  if (end === "00:00") endTime = endTime.add(1, "day");
  return t.isAfter(startTime) && t.isBefore(endTime);
}

/** Проверяет, есть ли в корзине только торты (и ничего кроме тортов) */
function isOnlyCakeInCart(cart) {
  const menu = getMenu();
  const items = Object.values(cart);
  if (!items.length) return false; // пустая корзина не считается
  return items.every((item) => {
    const fullDish = menu.find((d) => d.id === item.dish.id);
    return fullDish && fullDish.category?.toLowerCase().includes("торт");
  });
}

/** ================== УТИЛИТЫ СЕССИИ ЗАКАЗА ================== */
function endOrderSession(userId) {
  userStates.delete(userId);
}

function isOrderCallback(data) {
  // Разрешённые callback-и, относящиеся к оформлению заказа
  return (
    data === "cart_checkout" ||
    data === "start_order" ||
    data === "delivery_fast" ||
    data === "delivery_scheduled" ||
    data === "payment_card" ||
    data === "payment_cash" ||
    /^delivery_type_/.test(data) ||
    /^pickup_\d$/.test(data) ||
    /^operator_call_(yes|no)$/.test(data)
  );
}

/** ================== ГЛОБАЛЬНЫЕ ГАРДЫ ================== */
/**
 * СТАВЬ ПЕРВЫМ middleware:
 * - Любая команда ("/...") при активной сессии заказа => моментальный выход + пропускаем дальше (команда выполнится сразу)
 * - Любой "чужой" callback (не из isOrderCallback) => выход из заказа и пропускаем дальше
 * - Тексты внутри сессии — передаём в handleOrderStep; если он вернул false, сессия закрывается
 */
function attachOrderGuard(bot) {
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !userStates.has(userId)) {
      return next();
    }

    // "Чужой" callback -> выходим и пропускаем дальше
    if (ctx.updateType === "callback_query") {
      const data = ctx.callbackQuery?.data || "";
      if (!isOrderCallback(data)) {
        endOrderSession(userId);
        ctx.state = ctx.state || {};
        ctx.state.__order_exited = "callback";
        await ctx.answerCbQuery().catch(() => {});
        return next();
      }
      return next(); // наш order-callback, пусть обработается ниже
    }

    // Любая команда -> сразу выходим и даём обработаться командам
    if (ctx.message?.text?.startsWith("/")) {
      endOrderSession(userId);
      ctx.state = ctx.state || {};
      ctx.state.__order_exited = "command";
      return next();
    }

    // ---- КРИТИЧЕСКОЕ МЕСТО ----
    // Обычный текст отдаём визарду. Если он обработал (true) — НИКОГО дальше не зовём.
    const handled = await handleOrderStep(ctx);
    if (handled) {
      return; // <— не вызываем next(), чтобы то же сообщение не пошло во второй обработчик
    }

    // Если не обработал — закрываем сессию и пропускаем дальше
    endOrderSession(userId);
    ctx.state = ctx.state || {};
    ctx.state.__order_exited = "text";
    return next();
  });
}

/**
 * Не блокирует цепочку. Просто помечает апдейт, чтобы внешние логгеры/хранилища
 * могли не сохранять сообщение в «логах заказа».
 */
function markOrderExitForLoggers(bot) {
  bot.use(async (ctx, next) => {
    if (ctx.state?.__order_exited) {
      ctx.state.__suppressOrderLogging = true;
    }
    return next();
  });
}

/** ================== ОСНОВНОЙ WIZARD ОФОРМЛЕНИЯ ================== */
async function handleOrderStep(ctx) {
  if (ctx.chat.type !== "private") return false;
  const userId = ctx.from.id;
  if (!userStates.has(userId)) return false;

  // Если пользователь в чате с оператором — сразу выйти из заказа
  try {
    const { operatorChatUsers } = require("./operatorChat");
    if (operatorChatUsers.get(userId)) return false;
  } catch (_) {}

  const state = userStates.get(userId);
  const text = (ctx.message?.text || "").trim();

  switch (state.step) {
    case "name":
      state.name = text;
      state.step = "phone";
      await ctx.reply("📞 Укажите номер телефона (например, 79999999999):");
      break;

    case "phone": {
      const cleaned = text.replace(/[^\d]/g, "");
      const phoneRegex = /^(?:7|8|9)\d{9,10}$/;
      if (!phoneRegex.test(cleaned)) {
        await ctx.reply(
          "❌ Неверный формат номера. Введите, например: 79123456789"
        );
        return true;
      }
      let normalized = cleaned;
      if (normalized.startsWith("8")) normalized = "7" + normalized.slice(1);
      if (normalized.startsWith("9")) normalized = "7" + normalized;
      state.phone = "+".concat(normalized);
      state.step = "delivery_type";
      await ctx.reply("🚚 Выберите тип доставки:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚗 Доставка", callback_data: "delivery_type_delivery" }],
            [{ text: "🏃‍♂️ Самовывоз", callback_data: "delivery_type_pickup" }],
          ],
        },
      });
      break;
    }

    case "comment":
      state.comment = text;
      state.step = "operator_call";
      await ctx.reply(
        "📞 Требуется звонок оператора для подтверждения заказа?",
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Да", callback_data: "operator_call_yes" },
                { text: "❌ Нет", callback_data: "operator_call_no" },
              ],
            ],
          },
        }
      );
      break;

    case "payment": {
      const q = text.toLowerCase();
      if (q.includes("налич")) {
        state.paymentType = "Наличные";
        await finalizeOrder(ctx, state);
      } else if (q.includes("карт")) {
        if (!canPayByCard(state)) {
          await ctx.reply(
            "💳 Оплата картой доступна только при самовывозе. Пожалуйста, выберите наличные."
          );
          await ctx.reply("Выберите способ оплаты:", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💶 Наличные", callback_data: "payment_cash" }],
              ],
            },
          });
        } else {
          state.paymentType = "Карта";
          await finalizeOrder(ctx, state);
        }
      } else {
        await ctx.reply(
          "❌ Пожалуйста, выберите способ оплаты, используя кнопки ниже."
        );
      }
      break;
    }

    case "address":
      state.address = text;
      state.step = "delivery_speed";
      await ctx.reply("⏱ Выберите предпочтение по доставке:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Как можно быстрее", callback_data: "delivery_fast" }],
            [{ text: "📅 Предзаказ", callback_data: "delivery_scheduled" }],
          ],
        },
      });
      break;

    case "pickup_address":
      state.pickupAddress = text;
      state.step = "delivery_speed";
      await ctx.reply("⏱ Когда хотите забрать заказ?", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Как можно быстрее", callback_data: "delivery_fast" }],
            [{ text: "📅 Предзаказ", callback_data: "delivery_scheduled" }],
          ],
        },
      });
      break;

    case "date": {
      let userDate;
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
        userDate = tzParse(text, "DD.MM.YYYY");
      } else if (/^\d{2}\.\d{2}$/.test(text)) {
        const year = now().year();
        userDate = tzParse(`${text}.${year}`, "DD.MM.YYYY");
      } else {
        await ctx.reply(
          "❌ Неверный формат даты. Введите, например: 06.06 или 06.06.2024"
        );
        return true;
      }

      if (!userDate.isValid()) {
        await ctx.reply("❌ Неверная дата. Попробуйте ещё раз.");
        return true;
      }

      const minCakeDate = now().startOf("day").add(2, "day");
      // Только если ВЕСЬ заказ — торты, ограничиваем дату
      if (
        isOnlyCakeInCart(state.order.items) &&
        userDate.isBefore(minCakeDate)
      ) {
        const suggested = minCakeDate.format("DD.MM.YYYY");
        await ctx.reply(
          `🎂 Торты нужно заказывать минимум за 2 дня. Пожалуйста, выберите дату не раньше ${suggested}`
        );
        return true;
      }

      state.date_display = userDate.format("DD.MM.YYYY");
      state.date = userDate.format("YYYY-MM-DD");
      state.step = "time";
      await ctx.reply("⏰ Укажите время (например, 18:30):");
      break;
    }

    case "time":
      state.time = text;
      state.step = "comment";
      await ctx.reply(
        "💬 Есть комментарий к заказу? Если нет, напишите “нет”:"
      );
      break;

    default:
      await ctx.reply("❓ Пожалуйста, используйте кнопки.");
  }

  // Перепроверка: сессия ещё активна?
  if (userStates.has(userId)) {
    userStates.set(userId, state);
  }
  return true;
}

/** ================== ФИНАЛИЗАЦИЯ ================== */
async function finalizeOrder(ctx, state) {
  const userId = ctx.from.id;

  let message = `🏠 *Новый заказ c Telegram* (@${
    ctx.from.username || "без username"
  })\n\n`;
  message += `👤 *Имя:* ${state.name}\n`;
  message += `📞 *Телефон:* ${state.phone}\n`;
  message += `🚚 *Тип:* ${state.deliveryType}\n`;
  message += `📅 *Дата:* ${state.date_display || state.date || "не указана"}\n`;
  message += `⏰ *Время:* ${state.time}\n`;

  if (state.deliveryType === "Доставка") {
    message += `📍 *Адрес:* ${state.address}\n`;
  } else {
    message += `🏪 *Самовывоз:* ${state.pickupAddress}\n`;
  }

  message += `\n🛒 *Заказ:*\n`;
  for (const id in state.order.items) {
    const item = state.order.items[id];
    let title = item.dish.title;
    if (item.dish.modifier) title += ` (${item.dish.modifier})`;
    if (item.dish.noodleType) title += ` (${item.dish.noodleType})`;
    message += `• ${title} — ${item.quantity} шт. — ${
      item.dish.price * item.quantity
    }₽\n`;
  }

  message += `• 💼 Сервисный сбор — 39₽\n`;
  message += `\n💰 *Итого:* ${state.order.total}₽`;

  if (state.comment && state.comment.toLowerCase() !== "нет") {
    message += `\n\n💬 *Комментарий:* ${state.comment}`;
  }
  message += `\n📞 *Звонок оператора:* ${
    state.operatorCall ? "Да" : "Не требуется"
  }`;
  message += `\n💵 *Оплата:* ${state.paymentType || "не указано"}`;

  try {
    await ctx.reply(
      `✅ Ваш заказ принят!\n\n${message}\n\n🍽 Благодарим за заказ!`,
      { parse_mode: "Markdown" }
    );
    await ctx.telegram.sendMessage(ordersGroupId, message, {
      parse_mode: "Markdown",
    });

    // === ДОБАВЛЯЕМ ЗАКАЗ В ТАБЛИЦУ ===
    let dbDate = null;
    if (state.date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(state.date)) {
        dbDate = state.date;
      } else if (/^\d{2}\.\d{2}\.\d{4}$/.test(state.date)) {
        const [d, m, y] = state.date.split(".");
        dbDate = `${y}-${m}-${d}`;
      } else {
        dbDate = null;
      }
    }

    await pool.query(
      `INSERT INTO orders (tg_username, name, phone, order_type, date, time, address, items, total, comment, platform, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
      [
        ctx.from.username || null,
        state.name,
        state.phone,
        state.deliveryType,
        dbDate,
        state.time,
        state.deliveryType === "Доставка" ? state.address : state.pickupAddress,
        JSON.stringify(state.order.items),
        state.order.total,
        state.comment || null,
        "telegram",
      ]
    );

    startFeedback(ctx, userId);
  } catch (err) {
    console.error("Ошибка отправки в группу:", err);
  }

  clearCart(userId);
  userStates.delete(userId);
}

/** ================== РЕГИСТРАЦИЯ КНОПОК ================== */
function registerOrderHandler(bot) {
  // ВАЖНО: эти два — поставь САМЫМИ ПЕРВЫМИ в index.js (до других модулей)
  // attachOrderGuard(bot);
  // markOrderExitForLoggers(bot);

  bot.action("cart_checkout", async (ctx) => {
    const userId = ctx.from.id;
    const cart = userCarts[userId] || {};
    const total = getCartTotal(userId);

    if (!Object.keys(cart).length) {
      await ctx.answerCbQuery("Корзина пуста!", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    await ctx.reply(
      "🍽 Перед оформлением заказа, не хотите добавить что-нибудь ещё?",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🥤 Напитки", callback_data: "category_drinks" }],
            [{ text: "🍰 Десерты", callback_data: "category_desserts" }],
            [{ text: "🥫 Соусы", callback_data: "category_sauces" }],
            [{ text: "🧾 Перейти к оформлению", callback_data: "start_order" }],
          ],
        },
      }
    );
  });

  bot.action(/^operator_call_(yes|no)$/, async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    if (!state) return;

    state.operatorCall = ctx.match[1] === "yes";
    state.step = "payment";
    await ctx.answerCbQuery();

    const inline_keyboard = canPayByCard(state)
      ? [
          [
            { text: "💳 Карта", callback_data: "payment_card" },
            { text: "💶 Наличные", callback_data: "payment_cash" },
          ],
        ]
      : [[{ text: "💶 Наличные", callback_data: "payment_cash" }]];

    const hint = canPayByCard(state)
      ? "💳 Выберите способ оплаты:"
      : "💳 Оплата картой доступна только при самовывозе. Выберите способ оплаты:";

    await ctx.reply(hint, { reply_markup: { inline_keyboard } });
    userStates.set(userId, state);
  });

  bot.action("payment_card", async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    if (!state) return;

    if (!canPayByCard(state)) {
      await ctx.answerCbQuery("Оплата картой доступна только при самовывозе.", {
        show_alert: true,
      });
      // подсказать наличные
      await ctx.reply("Пожалуйста, выберите способ оплаты:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💶 Наличные", callback_data: "payment_cash" }],
          ],
        },
      });
      return;
    }

    state.paymentType = "Карта";
    await ctx.answerCbQuery("Вы выбрали оплату картой 💳");
    await finalizeOrder(ctx, state);
  });

  bot.action("payment_cash", async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    if (!state) return;
    state.paymentType = "Наличные";
    await ctx.answerCbQuery("Вы выбрали оплату наличными 💵");
    await finalizeOrder(ctx, state);
  });

  bot.action("start_order", async (ctx) => {
    const userId = ctx.from.id;
    const cart = userCarts[userId] || {};
    const total = getCartTotal(userId);

    userStates.set(userId, {
      step: "name",
      order: { items: cart, total },
    });
    await ctx.answerCbQuery();
    await ctx.reply("📝 Укажите ваше имя:");
  });

  bot.action(/^delivery_type_(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    if (!state) return;
    state.deliveryType = type === "delivery" ? "Доставка" : "Самовывоз";

    if (state.deliveryType === "Доставка") {
      state.step = "address";
      await ctx.answerCbQuery();
      await ctx.reply(
        "📍 Укажите адрес доставки, подъезд, квартиру, этаж и домофон (при наличии)"
      );
    } else {
      state.step = "pickup_location";
      await ctx.answerCbQuery();
      await ctx.reply("🏠 Выберите адрес самовывоза:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "ул. Баранова, 87", callback_data: "pickup_1" }],
            [{ text: "ул. Петрова, 27а", callback_data: "pickup_2" }],
            [{ text: "ул. Красная, 140", callback_data: "pickup_3" }],
          ],
        },
      });
    }
    userStates.set(userId, state);
  });

  bot.action(/^pickup_(\d)$/, async (ctx) => {
    const map = {
      1: "Удмуртия, Ижевск, ул. Баранова, 87",
      2: "Удмуртия, Ижевск, ул. Петрова, 27а",
      3: "Удмуртия, Ижевск, ул. Красная, 140",
    };
    const index = ctx.match[1];
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    if (!state) return;
    state.pickupAddress = map[index];

    const open = isRestaurantOpenNow();

    if (!open) {
      await ctx.answerCbQuery();
      await ctx.reply(
        "❌ Сейчас ресторан закрыт. Самовывоз возможен только с начала рабочего дня. Выберите предзаказ.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📅 Предзаказ", callback_data: "delivery_scheduled" }],
            ],
          },
        }
      );
      return;
    }

    state.step = "delivery_speed";
    await ctx.answerCbQuery();
    await ctx.reply("⏱ Когда хотите забрать заказ?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Как можно быстрее", callback_data: "delivery_fast" }],
          [{ text: "📅 Предзаказ", callback_data: "delivery_scheduled" }],
        ],
      },
    });
    userStates.set(userId, state);
  });

  bot.action("delivery_fast", async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    if (!state) return;
    const tNow = now();

    // Только торты — запрет быстрых
    if (isOnlyCakeInCart(state.order.items)) {
      const suggestedDate = tNow.add(2, "day").format("DD.MM.YYYY");
      await ctx.answerCbQuery();
      await ctx.reply(
        `🎂 Торты нужно заказывать минимум за 2 дня. Быстрая доставка невозможна.\nВыберите предзаказ и укажите дату начиная с ${suggestedDate}.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📅 Предзаказ", callback_data: "delivery_scheduled" }],
            ],
          },
        }
      );
      return;
    }

    // Всегда считаем ETA через единый хелпер
    const eta = getEarliestReady();
    state.date = eta.format("DD.MM.YYYY");
    state.time = eta.format("HH:mm");

    state.step = "comment";
    await ctx.answerCbQuery();
    await ctx.reply("💬 Есть комментарий к заказу? Если нет, напишите “нет”:");
    userStates.set(userId, state);
  });

  bot.action("delivery_scheduled", async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    if (!state) return;
    state.step = "date";
    await ctx.answerCbQuery();
    await ctx.reply("📅 Укажите дату (например, 25.05.2025):");
    userStates.set(userId, state);
  });
}

module.exports = {
  userStates,
  handleOrderStep,
  registerOrderHandler,
  attachOrderGuard,
  markOrderExitForLoggers,
};
