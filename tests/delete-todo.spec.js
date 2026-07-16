const { test, expect } = require('@playwright/test');

async function addTodo(page, text) {
  await page.locator('#new-todo').fill(text);
  await page.locator('#add-btn').click();
}

test('removes a todo item and updates the count', async ({ page }) => {
  await page.goto('/');

  await addTodo(page, 'Buy milk');
  await addTodo(page, 'Walk the dog');

  const items = page.locator('#todo-list .todo-item');
  await expect(items).toHaveCount(2);
  await expect(page.locator('#count')).toHaveText('2');

  // delete the first item ("Buy milk")
  await items.first().getByRole('button', { name: 'Delete' }).click();

  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Walk the dog');
  await expect(page.locator('#count')).toHaveText('1');
});
