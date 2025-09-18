module.exports = {
  // ===== Бизнес-ланчи с подкатегориями =====
  // Важно: значения child_category должны совпадать со столбцом child_category в menu.csv
  biznes_lunch: {
    title: "Бизнес-ланчи",
    subcats: [
      { key: "lunch_rolls", title: "Роллы", filter: { child_category: "Роллы" } },
      { key: "lunch_soupes", title: "Супы", filter: { child_category: "Супы" } },
      {
        key: "lunch_hotdish",
        title: "Горячие блюда",
        filter: { child_category: "Горячие блюда" },
      },
      { key: "lunch_salad", title: "Салаты", filter: { child_category: "Салаты" } },
    ],
  },

  // ===== Роллы с подкатегориями =====
  rolls: {
    title: "Роллы",
    subcats: [
      {
        key: "rolls_europe",
        title: "Европейские",
        filter: { child_category: "Европейские роллы" },
      },
      {
        key: "rolls_europe_0.5",
        title: "Европейские 1/2",
        filter: { child_category: "Европейские роллы 1/2" },
      },
      {
        key: "rolls_baked",
        title: "Запечённые",
        filter: { child_category: "Запечённые роллы" },
      },
      {
        key: "rolls_tempura",
        title: "Темпура",
        filter: { child_category: "Темпура роллы" },
      },
      {
        key: "rolls_maki",
        title: "Маки",
        filter: { child_category: "Маки роллы" },
      },
    ],
  },

  // ===== Прочие категории =====
  big_rolls: "BIG-роллы",
  sushi: "Суши",
  snacks: "Закуски",
  onigiri: "Онигири",
  salads: "Салаты",
  soups: "Супы",
  sets: "Сеты",
  hot_dishes: "Горячие блюда",
  wok: "WOK",
  kids_menu: "Детское меню",
  desserts: "Десерты",
  cakes: "Торты",
  drinks: "Напитки",
  sauces: "Соусы",
  special_dish: "🔥Сезонное меню🔥",
  burgers: "Бургеры",
};
