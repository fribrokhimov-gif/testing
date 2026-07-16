const { test, expect } = require('@playwright/test');

test('adds a new todo item to the list', async ({ page }) => {
  await page.goto('/');

  await page.locator('#new-todo').fill('Buy milk');
  await page.locator('#add-btn').click();

  const items = page.locator('#todo-list .todo-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Buy milk');
  await expect(page.locator('#count')).toHaveText('1');

  // the input should clear after adding
  await expect(page.locator('#new-todo')).toHaveValue('');
});
