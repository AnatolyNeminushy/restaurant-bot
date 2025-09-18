/**
 * Обработчики оформления заказа: витрина, корзина и сбор данных для оператора.
 * Содержит состояние пользователя, ветки для доставки/самовывоза и передачу заявки в чат.
 */
const { userCarts, getCartTotal, clearCart } = require("../order_cart/cart");
const { startFeedback } = require("./feedbackHandler");
const { getMenu } = require("../data/menu");
const dayjs = require("dayjs");
const timezone = require("dayjs/plugin/timezone");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Временное состояние пользователя в процессе оформления.
 * Ключ — Telegram userId, значение — шаг мастера и собранные данные.
 */
const userStates = new Map();
const ordersGroupId = process.env.GROUP_ORDER_APPL;

/**
 * Часы работы ресторана по дням недели (время дано в локальной тайм-зоне).
 */
const OPEN_HOURS = {
  0: ["09:00", "23:00"], // Sunday
  1: ["09:00", "23:00"],
  2: ["09:00", "23:00"],
  3: ["09:00", "23:00"],
  4: ["09:00", "00:00"],
  5: ["09:00", "00:00"],
  6: ["09:00", "23:00"], // Saturday
};

/**
 * Проверяет, открыт ли ресторан в текущий момент.
 */
function isRestaurantOpenNow() {
  const now = dayjs().tz("Asia/Yekaterinburg");
  const day = now.day();
  const [start, end] = OPEN_HOURS[day];
  const startTime = dayjs.tz(
    `${now.format("YYYY-MM-DD")} ${start}`,
    "Asia/Yekaterinburg"
  );
  let endTime = dayjs.tz(
    `${now.format("YYYY-MM-DD")} ${end}`,
    "Asia/Yekaterinburg"
  );
  if (end === "00:00") endTime = endTime.add(1, "day");
  return now.isAfter(startTime) && now.isBefore(endTime);
}

/**
 * Возвращает true, если в корзине только десерты (торты).
 */
function isCakeInCart(cart) {
  const menu = getMenu();
  return Object.values(cart).some((item) => {
    const fullDish = menu.find((d) => d.id === item.dish.id);
    return fullDish && fullDish.category?.toLowerCase().includes("торт");
  });
}

// === Вся логика шагов оформления заказа — вот тут ===
/**
 * Обрабатывает текстовые ответы пользователя в мастере заказа.
 * Возвращает true, если сообщение было частью сценария.
 */
async function handleOrderStep(ctx) {
  if (ctx.chat.type !== "private") return;
  const userId = ctx.from.id;
  if (!userStates.has(userId)) return;

  // Если пользователь в чате с оператором — игнорируем обработку заказа
  const { operatorChatUsers } = require("./operatorChat");
  if (operatorChatUsers.get(userId)) return;

  const state = userStates.get(userId);
  const text = ctx.message.text.trim();

  switch (state.step) {
    case "name":
      state.name = text;
      state.step = "phone";
      await ctx.reply("📞 Укажите номер телефона (например, 79999999999):");
      break;

    case "phone": {
      // Удаляем все лишние символы кроме цифр
      const cleaned = text.replace(/[^\d]/g, "");
      // Теперь проверяем: 11 цифр и начинается на 7,8,9
      const phoneRegex = /^(?:7|8|9)\d{9,10}$/;
      if (!phoneRegex.test(cleaned)) {
        await ctx.reply(
          "❌ Неверный формат номера. Введите, например: 79123456789"
        );
        return;
      }
      // Приводим к единому виду, например +7...
      let normalized = cleaned;
      if (normalized.startsWith("8")) normalized = "7" + normalized.slice(1);
      if (normalized.startsWith("9")) normalized = "7" + normalized;
      state.phone = "+".concat(normalized); // Для себя и для оператора (по желанию)
      state.step = "delivery_type";
      await ctx.reply("🚚 Выберите тип доставки:", {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚗 Доставка",
                callback_data: "delivery_type_delivery",
              },
            ],
            [{ text: "🏃‍♂️ Самовывоз", callback_data: "delivery_type_pickup" }],
          ],
        },
      });
      break;
    }
    case "comment":
      state.comment = text;
      await finalizeOrder(ctx, state);
      break;

    case "address":
      state.address = text;
      state.step = "delivery_speed";
      await ctx.reply("⏱ Выберите предпочтение по доставке:", {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚀 Как можно быстрее",
                callback_data: "delivery_fast",
              },
            ],
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
            [
              {
                text: "🚀 Как можно быстрее",
                callback_data: "delivery_fast",
              },
            ],
            [{ text: "📅 Предзаказ", callback_data: "delivery_scheduled" }],
          ],
        },
      });
      break;

    case "date": {
      // Пытаемся распарсить дату с годом или без года
      let userDate;
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
        // Формат ДД.ММ.ГГГГ
        userDate = dayjs(text, "DD.MM.YYYY").tz("Asia/Yekaterinburg");
      } else if (/^\d{2}\.\d{2}$/.test(text)) {
        // Формат ДД.ММ (без года)
        const year = dayjs().year();
        userDate = dayjs(`${text}.${year}`, "DD.MM.YYYY").tz(
          "Asia/Yekaterinburg"
        );
      } else {
        await ctx.reply(
          "❌ Неверный формат даты. Введите, например: 06.06 или 06.06.2024"
        );
        return;
      }

      const now = dayjs().tz("Asia/Yekaterinburg").startOf("day");
      const minCakeDate = now.add(2, "day");

      if (
        isCakeInCart(userStates.get(userId).order.items) &&
        userDate.isBefore(minCakeDate)
      ) {
        const suggested = minCakeDate.format("DD.MM.YYYY");
        await ctx.reply(
          `🎂 Торты нужно заказывать минимум за 2 дня. Пожалуйста, выберите дату не раньше ${suggested}`
        );
        return;
      }

      state.date = userDate.format("DD.MM.YYYY");
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

  userStates.set(userId, state);
}

async function finalizeOrder(ctx, state) {
  const userId = ctx.from.id;
  let message = `🏠 *Новый заказ* (@${
    ctx.from.username || "без username"
  })\n\n`;
  message += `👤 *Имя:* ${state.name}\n`;
  message += `📞 *Телефон:* ${state.phone}\n`;
  message += `🚚 *Тип:* ${state.deliveryType}\n`;
  message += `📅 *Дата:* ${state.date}\n`;
  message += `⏰ *Время:* ${state.time}\n`;
  if (state.deliveryType === "Доставка") {
    message += `📍 *Адрес:* ${state.address}\n`;
  } else {
    message += `🏪 *Самовывоз:* ${state.pickupAddress}\n`;
  }
  message += `\n🛒 *Заказ:*\n`;
  for (const id in state.order.items) {
    const item = state.order.items[id];
    message += `• ${item.dish.title} — ${item.quantity} шт. — ${
      item.dish.price * item.quantity
    }₽\n`;
  }
  message += `\n💰 *Итого:* ${state.order.total}₽`;

  if (state.comment && state.comment.toLowerCase() !== "нет") {
    message += `\n\n💬 *Комментарий:* ${state.comment}`;
  }

  try {
    await ctx.reply(
      `✅ Ваш заказ принят!\n\n${message}\n\n🍽 Благодарим за заказ! Ожидайте, скоро мы с вами свяжемся.`,
      { parse_mode: "Markdown" }
    );
    await ctx.telegram.sendMessage(ordersGroupId, message, {
      parse_mode: "Markdown",
    });
    startFeedback(ctx, userId);
  } catch (err) {
    console.error("Ошибка отправки в группу:", err);
  }

  clearCart(userId);
  userStates.delete(userId);
}

// ==== Все action (callback_query) регистрируй как раньше ====
/**
 * Регистрирует все обработчики callback_query, связанные с оформлением заказа.
 */
function registerOrderHandler(bot) {
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
            [{ text: "🥗 Салаты", callback_data: "category_salads" }],
            [{ text: "🍟 Закуски", callback_data: "category_snacks" }],
            
            [{ text: "🧾 Перейти к оформлению", callback_data: "start_order" }],
          ],
        },
      }
    );
  });

  bot.action("start_order", async (ctx) => {
    const userId = ctx.from.id;
    const cart = userCarts[userId] || {};
    const total = getCartTotal(userId);

    userStates.set(userId, {
      step: "name",
      order: {
        items: cart,
        total,
      },
    });
    await ctx.answerCbQuery();
    await ctx.reply("📝 Укажите ваше имя:");
  });

  bot.action(/^delivery_type_(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    state.deliveryType = type === "delivery" ? "Доставка" : "Самовывоз";

    if (state.deliveryType === "Доставка") {
      state.step = "address";
      await ctx.answerCbQuery();
      await ctx.reply("📍 Укажите адрес доставки:");
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
    state.pickupAddress = map[index];

    const open = isRestaurantOpenNow();
    const now = dayjs().tz("Asia/Yekaterinburg");

    if (!open) {
      
      await ctx.answerCbQuery();
      await ctx.reply(
        `❌ Сейчас ресторан закрыт. Самовывоз возможен только с начала рабочего дня. Выберите предзаказ.`,
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
    const now = dayjs().tz("Europe/Samara");
    const open = isRestaurantOpenNow();

    const hasCake = isCakeInCart(state.order.items);
    const suggestedDate = now.add(2, "day").format("DD.MM.YYYY");

    if (hasCake) {
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

    if (!open) {
      const tomorrow = now.add(1, "day").format("DD.MM.YYYY");
      await ctx.answerCbQuery();
      await ctx.reply(
        `❌ Сейчас ресторан закрыт. Заказ будет оформлен на завтра — ${tomorrow}`
      );
      state.date = tomorrow;
      state.time = now.add(90, "minute").format("HH:mm"); // Тоже на 1.5 часа вперед
    } else {
      state.date = now.format("DD.MM.YYYY");
      state.time = now.add(90, "minute").format("HH:mm"); // <--- вот здесь добавляем 1.5 часа
    }

    state.step = "comment";
    await ctx.reply("💬 Есть комментарий к заказу? Если нет, напишите “нет”:");
    userStates.set(userId, state);
  });

  bot.action("delivery_scheduled", async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    state.step = "date";
    await ctx.answerCbQuery();
    await ctx.reply("📅 Укажите дату (например, 25.05.2025):");
    userStates.set(userId, state);
  });
}

module.exports = {
  userStates,
  handleOrderStep,
  registerOrderHandler, // (для action/callback_query)
};
