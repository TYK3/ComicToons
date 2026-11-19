import { expect, test } from '@playwright/test';

test('book and director stub pages render their heading', async ({ page }) => {
  await page.goto('/book/sample-issue');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Book sample-issue');
  await page.goto('/director');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Director');
});
