// menu.js — загрузка ассортимента из CSV в оперативный кэш
const fs = require("fs");
const csv = require("csv-parser");

// Держим меню в памяти, чтобы не читать CSV при каждом обращении
let menuCache = [];

/**
 * Подготавливает кэш меню из assets/menu.csv.
 * CSV формируется в админке, поэтому здесь мы лишь аккуратно читаем файл
 * и присваиваем каждому блюду предсказуемый идентификатор.
 */
async function loadMenu() {
  return new Promise((resolve, reject) => {
    const temp = [];

    fs.createReadStream("./assets/menu.csv")
      .pipe(csv())
      // При чтении каждой строки аккумулируем исходные поля
      .on("data", (row) => temp.push(row))
      // После завершения чтения формируем структуру для бота
      .on("end", () => {
        menuCache = temp.map((item, index) => ({
          ...item,
          // dish_<index> — достаточно уникально для inline-клавиатур
          id: `dish_${index}`,
        }));

        console.log("Меню загружено:", menuCache.length, "позиций");
        resolve();
      })
      .on("error", (err) => {
        console.error("Ошибка чтения CSV:", err);
        reject(err);
      });
  });
}

/** Возвращает закэшированное меню (результат loadMenu). */
function getMenu() {
  return menuCache;
}

module.exports = {
  loadMenu,
  getMenu,
  menuCache,
};
