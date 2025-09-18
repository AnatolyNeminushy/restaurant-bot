// Версия 2.0

require('dotenv-flow').config();

const { Telegraf, Context } = require("telegraf");
const express = require("express");
const cors = require("cors");

// ✅ Импорт настроенного пула
const pool = require("./server/db");

const groupOrdersId = process.env.TG_GROUP_ORDERS_ID;
const groupReservesId = process.env.TG_GROUP_RESERVES_ID;

/* ===================== Антикреш-глобалки ===================== */
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

/* ===================== Express API ===================== */
const app = express();
app.use(cors());
const port = 5000;

// ✅ Тестовое подключение
pool
  .query("SELECT NOW()")
  .then((res) => console.log("✅ Подключение успешно:", res.rows[0]))
  .catch((err) => console.error("❌ Ошибка подключения:", err));

// Хелпер, чтобы любой маршрут не валил процесс
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error("EXPRESS ROUTE ERROR:", e);
    res.status(503).json({ error: "Temporary server error" });
  });

// Перехватываем все ответы бота и логируем их в БД, но не блокируем ответ
const replyOrig = Context.prototype.reply;

Context.prototype.reply = async function (...args) {
  try {
    if (this.chat && args[0]) {
      (async () => {
        try {
          // 🔹 добавляем upsert для чата с платформой 'tg'
          await pool.query(
            `INSERT INTO chats (chat_id, platform)
             VALUES ($1, 'tg')
             ON CONFLICT (chat_id) DO UPDATE
               SET platform = COALESCE(chats.platform, EXCLUDED.platform)`,
            [this.chat.id]
          );

          // 🔹 сохраняем ответ бота как сообщение
          await pool.query(
            `INSERT INTO messages (chat_id, from_me, text, date)
             VALUES ($1, $2, $3, NOW())`,
            [this.chat.id, true, String(args[0])]
          );
        } catch (e) {
          console.error("Ошибка при сохранении ответа бота:", e);
        }
      })();
    }
  } catch (e) {
    console.error("Ошибка override reply:", e);
  }

  return replyOrig.apply(this, args);
};

// Получить список чатов
app.get(
  "/api/chats",
  asyncHandler(async (req, res) => {
    const result = await pool.query("SELECT * FROM chats ORDER BY id DESC");
    res.json(result.rows);
  })
);

// Получить сообщения чата
app.get(
  "/api/messages",
  asyncHandler(async (req, res) => {
    const { chatId } = req.query;
    const result = await pool.query(
      "SELECT * FROM messages WHERE chat_id = $1 ORDER BY date",
      [chatId]
    );
    res.json(result.rows);
  })
);

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});

// --- ВСЕГО ЗАКАЗОВ
app.get(
  "/api/stat/orders",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM orders`);
    res.json({ count: Number(rows[0].count) });
  })
);

// Сортировка по времени (по created_at)
app.get(
  "/api/stat/orders-by-created",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT 
        created_at::date as day, 
        COUNT(*) as count, 
        SUM(total) as sum
      FROM orders
      GROUP BY day 
      ORDER BY day DESC 
      LIMIT 14
    `);
    res.json(rows);
  })
);

// --- ВСЕГО БРОНИРОВАНИЙ
app.get(
  "/api/stat/reserves",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM reservations`);
    res.json({ count: Number(rows[0].count) });
  })
);

// --- СУММА ЗАКАЗОВ
app.get(
  "/api/stat/orders-sum",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`SELECT SUM(total) as sum FROM orders`);
    res.json({ sum: Number(rows[0].sum) || 0 });
  })
);

// --- ГРАФИК: ЗАКАЗЫ ПО ДНЯМ
app.get(
  "/api/stat/orders-by-day",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT 
        date::date as day, 
        COUNT(*) as count, 
        SUM(total) as sum
      FROM orders
      GROUP BY day 
      ORDER BY day DESC 
      LIMIT 14
    `);
    res.json(rows);
  })
);

// --- СРЕДНИЙ ЧЕК, МАКСИМУМ ЗА ДЕНЬ
app.get(
  "/api/stat/orders-extra",
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT total, date::date as day
      FROM orders
    `);
    const totals = rows.map((r) => Number(r.total) || 0);
    const avg = totals.length
      ? totals.reduce((a, b) => a + b, 0) / totals.length
      : 0;

    const byDay = {};
    rows.forEach((r) => {
      const day = r.day;
      const total = Number(r.total) || 0;
      byDay[day] = Math.max(byDay[day] || 0, total);
    });
    const maxDay = Object.values(byDay).length
      ? Math.max(...Object.values(byDay))
      : 0;

    res.json({ avg: Math.round(avg), maxDay });
  })
);

/* ===================== Telegraf Bot ===================== */

// Загрузка данных меню

const { loadMenu, getMenu } = require("./data/menu");
const registerMainHandlers = require("./handlers/main");
const registerOrderHandlers = require("./handlers/order");
const registerOperatorHandler = require("./handlers/operator");
const { registerFeedbackHandler } = require("./handlers/feedbackHandler");
const { registerMessageHandler } = require("./middlewares/message");
const {
  attachOrderGuard,
  markOrderExitForLoggers,
  registerOrderHandler,
} = require("./middlewares/orderHandler");
const {
  registerOperatorChat,
  setMenuCache,
  startOperatorChat,
} = require("./middlewares/operatorChat");
const {
  registerReserveHandler,
  attachReservationGuard,
  markReserveExitForLoggers,
} = require("./middlewares/reserveHandler");
const cart = require("./order_cart/cart");
const { attachPolicyHandlers } = require("./utils/policyHandler");

const bot = new Telegraf(process.env.BOT_TOKEN);

// Ловим любые ошибки внутри Telegraf-мидлварей/хэндлеров
bot.catch((err, ctx) => {
  console.error("TELEGRAF ERROR at", ctx?.updateType, err);
});

// ====== Универсальный обработчик для БД (message) ======
bot.on("message", async (ctx, next) => {
  // Пишем в БД в фоне, чтобы не блокировать обработку
  (async () => {
    try {
      const from = ctx.from || {};
      const text = ctx.message?.text || "";

      await pool.query(
        `INSERT INTO chats (chat_id, platform, username, first_name, last_name)
   VALUES ($1, 'tg', $2, $3, $4)
   ON CONFLICT (chat_id) DO UPDATE
     SET platform   = COALESCE(chats.platform, EXCLUDED.platform),
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name`,
        [
          from.id,
          from.username || null,
          from.first_name || null,
          from.last_name || null,
        ]
      );

      await pool.query(
        `INSERT INTO messages (chat_id, from_me, text, date)
         VALUES ($1, $2, $3, NOW())`,
        [from.id, false, text]
      );

      console.log("Новое сообщение:", from.id, from.username, text);
    } catch (e) {
      console.error("Ошибка при сохранении чата/сообщения:", e);
    }
  })();

  if (typeof next === "function") return next(); // важно!
});

// ====== Сохранение нажатий на inline-кнопки ======
bot.on("callback_query", async (ctx, next) => {
  // 0) Сразу убрать «часики», чтобы не словить 400: query is too old
  try {
    await ctx.answerCbQuery(); // можно текст: await ctx.answerCbQuery('Обрабатываю...');
  } catch (e) {
    console.error("answerCbQuery error:", e?.description || e);
  }

  // 1) Лёгкий лог (без падений)
  try {
    console.log(
      "НАЖАТИЕ КНОПКИ:",
      ctx.from?.id,
      ctx.from?.username,
      ctx.callbackQuery?.data
    );
  } catch (e) {
    console.error("callback log error:", e);
  }

  // 2) Пишем в БД в фоне
  (async () => {
    try {
      await pool.query(
        `INSERT INTO chats (chat_id, platform, username, first_name, last_name)
   VALUES ($1, 'tg', $2, $3, $4)
   ON CONFLICT (chat_id) DO UPDATE
     SET platform   = COALESCE(chats.platform, EXCLUDED.platform),
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name`,
        [
          ctx.from?.id,
          ctx.from?.username || null,
          ctx.from?.first_name || null,
          ctx.from?.last_name || null,
        ]
      );

      // ==== Ищем текст кнопки по callback_data ====
      let buttonText = `[button] ${ctx.callbackQuery?.data}`;
      const allRows =
        ctx.callbackQuery?.message?.reply_markup?.inline_keyboard || [];
      for (const row of allRows) {
        for (const btn of row) {
          if (btn.callback_data === ctx.callbackQuery?.data) {
            buttonText = btn.text;
          }
        }
      }

      // Сохраняем нажатие как «сообщение» (текст кнопки)
      await pool.query(
        `INSERT INTO messages (chat_id, from_me, text, date)
         VALUES ($1, $2, $3, NOW())`,
        [ctx.from?.id, false, buttonText]
      );
    } catch (e) {
      console.error("Ошибка при сохранении callback_query:", e);
    }
  })();

  if (typeof next === "function") return next();
});

(async () => {
  try {
    // Загрузка меню
    await loadMenu();
    console.log("✅ Меню загружено");

    // Кэш меню для ИИ
    const menuText = getMenu()
      .map((item) => `${item.title} — ${item.description || ""}`)
      .join("\n");
    setMenuCache(menuText);

    // Команды
    bot.command("cart", async (ctx) => {
      try {
        await cart.showCart(ctx);
      } catch (e) {
        console.error("cart.showCart error:", e);
        try {
          await ctx.reply("Произошла ошибка при показе корзины.");
        } catch (e2) {
          console.error("reply error:", e2);
        }
      }
    });

    bot.command("operator", (ctx) => {
      try {
        const userId = ctx.from?.id;
        if (userId) startOperatorChat(userId);
        ctx.reply("Вы вошли в чат с оператором. Напишите ваш вопрос.");
      } catch (e) {
        console.error("operator command error:", e);
      }
    });

    // Обработчики
    // ===== 1) Глобальные гарды САМЫЕ ПЕРВЫЕ =====
    attachReservationGuard(bot); // бронь: ловит /команды и "чужие" кнопки
    markReserveExitForLoggers(bot); // только пометка для логов, не блокирует

    attachOrderGuard(bot); // заказ: ловит /команды и "чужие" кнопки
    markOrderExitForLoggers(bot); // пометка для логов

    // ===== 2) Регистрация модулей, чьи action/command должны работать сразу после гардов =====
    registerReserveHandler(bot); // reserve_* action'ы, шаговик брони
    registerOrderHandlers(bot); // action'ы заказа (категории и т.п.)
    registerOrderHandler(bot); // wizard оформления (если отдельный модуль)

    // ===== 3) Оператор — до общих, иначе общие перехватят сообщения
    registerOperatorChat(bot);
    registerOperatorHandler(bot);

    // ===== 4) Основная навигация/меню/команды
    registerMainHandlers(bot);

    // ===== 5) Корзина и прочее
    cart.registerCartHandlers(bot);
    registerFeedbackHandler(bot);
    attachPolicyHandlers(bot);

    // ===== 6) Самый общий «поймай всё»
    registerMessageHandler(bot);

    console.log("✅ Все обработчики зарегистрированы");

    // Запуск бота
    await bot.launch();
    console.log("🤖 Бот запущен");
    logger.info("bot_started", { meta: { pid: process.pid } });
    // Грациозная остановка
    const stop = async () => {
      try {
        console.log("⛔ Остановка...");
        await bot.stop("SIGTERM");
        process.exit(0);
      } catch (e) {
        console.error("Ошибка при остановке бота:", e);
        process.exit(1);
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (err) {
    console.error("Ошибка инициализации или запуска:", err.stack || err);
  }
})();
