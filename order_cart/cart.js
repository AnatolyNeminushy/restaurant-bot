/**
 * Логика работы с пользовательскими корзинами.
 * Данные временные, используются только для текущей сессии.
 */
const { Markup } = require('telegraf');

const SERVICE_FEE = 39; // фиксированный сервисный сбор
const userCarts = {}; // userId -> { [dishId]: { dish, quantity } }

// Создаёт корзину пользователя, если её ещё не существует.
function ensureCart(userId) {
  if (!userCarts[userId]) {
    userCarts[userId] = {};
  }
  return userCarts[userId];
}

// Добавляет блюдо в корзину или увеличивает его количество.
function addToCart(userId, dish) {
  const cart = ensureCart(userId);
  if (!cart[dish.id]) {
    cart[dish.id] = { dish, quantity: 1 };
  } else {
    cart[dish.id].quantity += 1;
  }
}

// Уменьшает количество блюда; удаляет позицию, если значение стало нулевым.
function decreaseFromCart(userId, dishId) {
  const cart = userCarts[userId];
  if (!cart || !cart[dishId]) return;
  cart[dishId].quantity -= 1;
  if (cart[dishId].quantity <= 0) {
    delete cart[dishId];
  }
}

// Полностью очищает корзину пользователя.
function clearCart(userId) {
  userCarts[userId] = {};
}

// Возвращает сумму заказа с учётом сервисного сбора.
function getCartTotal(userId) {
  const cart = userCarts[userId] || {};
  const subtotal = Object.values(cart).reduce(
    (sum, entry) => sum + entry.dish.price * entry.quantity,
    0
  );
  return subtotal + SERVICE_FEE;
}

function formatCurrency(value) {
  return `${value} руб.`;
}

// Формирует текст корзины для отображения пользователю.
function buildCartText(cart, total) {
  const lines = ['В вашей корзине:', ''];

  Object.values(cart).forEach((entry) => {
    const modifiers = [entry.dish.modifier, entry.dish.noodleType].filter(Boolean);
    const title = modifiers.length
      ? `${entry.dish.title} (${modifiers.join(', ')})`
      : entry.dish.title;
    const price = entry.dish.price * entry.quantity;
    lines.push(`${title} — ${entry.quantity} шт. × ${formatCurrency(price)}`);
  });

  lines.push('', `Сервисный сбор: ${formatCurrency(SERVICE_FEE)}`);
  lines.push(`Сумма заказа: ${formatCurrency(total)}`);
  lines.push('', 'Дождитесь подтверждения от оператора перед оплатой.');

  return lines.join('');
}

// Показывает корзину в зависимости от контекста (ответ или редактирование сообщения).
async function showCart(ctx) {
  const userId = ctx.from.id;
  const cart = userCarts[userId] || {};
  const keyboard = getCartKeyboard(userId);

  if (Object.keys(cart).length === 0) {
    const message = 'Корзина пуста.';
    if (ctx.updateType === 'callback_query' && ctx.update?.callback_query?.message) {
      await ctx.editMessageText(message, keyboard);
    } else {
      await ctx.reply(message, keyboard);
    }
    return;
  }

  const subtotal = Object.values(cart).reduce(
    (sum, entry) => sum + entry.dish.price * entry.quantity,
    0
  );
  const total = subtotal + SERVICE_FEE;
  const text = buildCartText(cart, total);

  if (ctx.updateType === 'callback_query' && ctx.update?.callback_query?.message) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

// Собирает инлайн-клавиатуру для управления корзиной.
function getCartKeyboard(userId) {
  const cart = userCarts[userId] || {};
  const buttons = [];

  for (const dishId in cart) {
    const entry = cart[dishId];
    buttons.push([
      Markup.button.callback('-', `cart_decrease_${dishId}`),
      Markup.button.callback(`Кол-во: ${entry.quantity}`, 'show_cart'),
      Markup.button.callback('+', `cart_increase_${dishId}`),
    ]);
  }

  if (Object.keys(cart).length > 0) {
    buttons.push([Markup.button.callback('Очистить корзину', 'cart_clear')]);
    buttons.push([Markup.button.callback('Перейти к оформлению', 'cart_checkout')]);
  }

  buttons.push([
    Markup.button.callback('← Вернуться к меню', 'button_food_clicked'),
  ]);

  return Markup.inlineKeyboard(buttons);
}

/**
 * Регистрирует команды и callback-хендлеры для управления корзиной.
 */
function registerCartHandlers(bot) {
  bot.command('cart', showCart);

  bot.action(/^cart_increase_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const dishId = ctx.match[1];
    const cart = userCarts[userId];
    if (!cart || !cart[dishId]) {
      await ctx.answerCbQuery('Блюдо уже удалено.', { show_alert: true });
      return;
    }
    cart[dishId].quantity += 1;
    await ctx.answerCbQuery('Добавлено 1 шт.');
    await showCart(ctx);
  });

  bot.action(/^cart_decrease_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const dishId = ctx.match[1];
    decreaseFromCart(userId, dishId);
    await ctx.answerCbQuery('Убрано 1 шт.');
    await showCart(ctx);
  });

  bot.action('cart_clear', async (ctx) => {
    clearCart(ctx.from.id);
    await ctx.answerCbQuery('Корзина очищена.');
    await showCart(ctx);
  });
}

module.exports = {
  userCarts,
  addToCart,
  decreaseFromCart,
  clearCart,
  getCartTotal,
  getCartKeyboard,
  showCart,
  registerCartHandlers,
};