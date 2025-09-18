// Версия оператора 2.2 — OpenRouter (через OpenAI SDK)

const { OpenAI } = require("openai");

const operatorChatUsers = new Map();
const userHistories = new Map();
let menuCache = "";

/** ———————————— OpenRouter клиент ———————————— */
// Используем AI_API_KEY из .env
const openai = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": process.env.PROJECT_PUBLIC_URL || "https://example.com",
    "X-Title": "Ayami Operator Bot",
  },
});

/** ———————————— ВСПОМОГАТЕЛЬНЫЕ ———————————— */
function isOperatorActive(userId) {
  return Boolean(operatorChatUsers.get(userId));
}

async function exitOperatorFor(ctx, reasonMsg = null) {
  const userId = ctx.from?.id;
  if (!userId || !isOperatorActive(userId)) return;

  operatorChatUsers.delete(userId);
  userHistories.delete(userId);

  if (reasonMsg) {
    try {
      await ctx.reply(reasonMsg, {
        reply_markup: {
          inline_keyboard: [[{ text: "📋 Меню", callback_data: "button_food_clicked" }]],
        },
      });
    } catch {}
  }
}

/** ———————————— ОСНОВНАЯ ЛОГИКА ОПЕРАТОРА ———————————— */
async function handleOperatorMessage(ctx) {
  const userId = ctx.from.id;
  if (!operatorChatUsers.get(userId)) return;

  const userMessage = ctx.message?.text;
  if (!userMessage) return;

  const chatId = ctx.chat.id;

  try {
    await ctx.telegram.sendChatAction(chatId, "typing");
    await ctx.reply("⌛️ Оператор обрабатывает ваш вопрос...");

    // поддерживаем «печатает…» пока ждём ответ
    const typingInterval = setInterval(() => {
      ctx.telegram.sendChatAction(chatId, "typing").catch(() => {});
    }, 3000);

    // таймаут и отмена
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const history = userHistories.get(userId) || [];
    history.push({ role: "user", content: userMessage });

    // системный промпт
    const systemMsg = {
      role: "system",
      content: `# Время запроса: ${(() => {
        const now = new Date();
        now.setHours(now.getHours() + 1); // МСК + 1 час
        return now.toLocaleString("ru-RU", {
          timeZone: "Europe/Moscow",
          hour12: false,
        });
      })()}

# Роль ассистента
Ты — профессиональный AI-ассистент японского ресторана «Аями». Твоя задача — вежливо и чётко консультировать клиентов по меню, помогать выбрать блюда, делать апсейл строго по меню и отвечать на вопросы о ресторане.

Меню:
${menuCache}

# Данные о ресторане
Рестораны «Аями» находятся по адресам:
1. ул. Красная, 140
2. ул. Петрова, 27А
3. ул. Баранова, 87, Молл "Матрица", 3 этаж

🕒 График работы:
— Понедельник–Четверг: 10:00–22:00
— Пятница–Воскресенье: 10:00–23:00

# Стиль общения
- Вежливый, профессиональный, но тёплый
- Используй смайлики в меру
- Блюда обязательно нумеруй

# Цель
- Помочь клиенту сделать осознанный выбор
- Повысить ценность заказа через рекомендации
- Отвечать на любые вопросы, связанные с меню и рестораном
- Если не понимаешь запрос — ответь: "Уточните, пожалуйста!"
- Если у гостя день рождения, повышенный кэшбэк 10% на заказ.
- Если гость выбрал какое-то блюдо, подскажи как его заказать через меню, обязательно!!!!

# Запрещено
- Не записывать и не оформлять заказы
- Не выдумывать блюда, ингредиенты или цены
- Не собирать адреса, телефоны и т.п.
- Не говорить о доставке или самовывозе — ты консультируешь, но не обслуживаешь`,
    };

    // вызов OpenRouter Chat Completions
    const completion = await openai.chat.completions.create(
      {
        model: "openai/gpt-4o-mini", // через OpenRouter
        temperature: 0.5,
        messages: [
          systemMsg,
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: userMessage },
        ],
      },
      { signal: controller.signal }
    );

    clearTimeout(timeout);
    clearInterval(typingInterval);

    const replyText =
      completion.choices?.[0]?.message?.content?.trim() || "⚠️ Ответ пуст.";

    history.push({ role: "assistant", content: replyText });
    userHistories.set(userId, history.slice(-10));

    await new Promise((r) => setTimeout(r, 1000));

    await ctx.reply(replyText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Меню", callback_data: "button_food_clicked" }],
          [{ text: "❌ Выйти из диалога", callback_data: "exit_operator_chat" }],
        ],
      },
    });
  } catch (err) {
    try {
      await ctx.telegram.sendChatAction(ctx.chat.id, "cancel");
    } catch {}

    if (err.name === "AbortError") {
      await ctx.reply("⚠️ Время ожидания истекло. Попробуйте позже.");
    } else {
      await ctx.reply(`⚠️ Ошибка: ${err.message}`);
    }
  }
}

/** ———————————— РЕГИСТРАЦИЯ И МИДЛВАР ———————————— */
function registerOperatorChat(bot) {
  bot.action("exit_operator_chat", async (ctx) => {
    await exitOperatorFor(
      ctx,
      "✅ Вы вышли из чата с оператором. Используйте /operator, чтобы снова начать."
    );
    await ctx.answerCbQuery().catch(() => {});
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;

    if (!userId || !isOperatorActive(userId)) {
      return next();
    }

    if (ctx.updateType === "callback_query") {
      if (ctx.callbackQuery?.data === "exit_operator_chat") {
        return;
      }
      await exitOperatorFor(
        ctx,
        "ℹ️ Вы выбрали действие вне чата с оператором. Диалог остановлен — выполняю ваш выбор."
      );
      return next();
    }

    const text = ctx.message?.text || "";
    if (text.startsWith("/")) {
      if (text.trim() !== "/operator") {
        await exitOperatorFor(
          ctx,
          "ℹ️ Вы ввели команду. Диалог с оператором закрыт — выполняю команду."
        );
      }
      return next();
    }

    await handleOperatorMessage(ctx);
  });
}

/** ———————————— ВКЛЮЧЕНИЕ/ДАННЫЕ ———————————— */
function startOperatorChat(userId) {
  operatorChatUsers.set(userId, true);
  userHistories.set(userId, []);
}

function setMenuCache(menuText) {
  menuCache = menuText;
}

module.exports = {
  registerOperatorChat,
  startOperatorChat,
  setMenuCache,
  userHistories,
  operatorChatUsers,
  handleOperatorMessage,
};
