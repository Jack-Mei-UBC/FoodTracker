# Roadmap — candidate features

Ideas queued for future work, roughly ordered by how naturally they build on what exists today.
Nothing here is committed; pick one and plan it against the invariants in [CLAUDE.md](CLAUDE.md).

## Meal-plan extensions
1. **Shopping list** — aggregate the ingredients of one or more meals, subtract what's on hand, and pick the cheapest recent store per item from price history.
2. **Weekly planner calendar** — assign meals to days/slots, one-tap log, weekly cost + macro forecast.
3. **Price-aware AI generation** — include latest prices in the `/api/meals/generate` prompt: "cheapest meal hitting these macros".
4. **Fridge/pantry inventory** — a table of quantities on hand, decremented when a meal is logged; restrict AI generation to in-stock items.
5. **Leftovers tracking** — a meal makes 4 servings, log 1, the app remembers 3 remain.
6. **"Save diary day as meal"** — import a past day's diary entries into a new meal.
7. **Meal tags & favorites** — high-protein / cheap / quick tags for filtering.
8. **Cost-per-meal trend** — meals store amounts, so cost is recomputable against any point in price history; chart it over time.
9. **Nutrition-completeness warnings on the dashboard** — surface foods missing facts so meal totals aren't silently understated (the meal builder already flags this inline).
10. **Recipe scaling** — a ×2-all-amounts button, distinct from the servings count.
