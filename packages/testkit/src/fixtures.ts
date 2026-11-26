/**
 * Small hand-written re-application fixtures (Python and TypeScript) for the mutation operators.
 * `before` is the post-revert state, `after` the state at C.
 */
export interface MutationFixture {
  name: string;
  path: string;
  before: string;
  after: string;
}

export const PY_FIXTURE: MutationFixture = {
  name: 'py-pricing',
  path: 'shop/pricing.py',
  before: `"""Pricing helpers."""
import math


def subtotal(items, limit):
    total = 0
    for item in items:
        total += item.price
    return total


class Cart:
    currency = "EUR"

    def total(self, items, discount):
        amount = subtotal(items, None)
        return amount
`,
  after: `"""Pricing helpers."""
import math


def subtotal(items, limit):
    total = 0
    count = 0
    for item in items:
        if item.price > limit:
            continue
        total += item.price * item.quantity
        count += item.quantity
    if count > 10:
        total = total * 0.95
    else:
        total = total + 1
    return math.floor(total * 100) / 100


class Cart:
    currency = "EUR"

    def total(self, items, discount):
        amount = subtotal(items, self.limit)
        rate = discount.rate
        reduced = amount - amount * rate
        if reduced < 0:
            reduced = 0
        return round(reduced, 2)
`,
};

export const TS_FIXTURE: MutationFixture = {
  name: 'ts-pricing',
  path: 'src/pricing.ts',
  before: `import { round } from './math';

export function subtotal(items: Item[], limit: number): number {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
}

export class Cart {
  currency = 'EUR';

  total(items: Item[], discount: Discount): number {
    const amount = subtotal(items, 0);
    return amount;
  }
}
`,
  after: `import { round } from './math';

export function subtotal(items: Item[], limit: number): number {
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (item.price > limit) {
      continue;
    }
    total += item.price * item.quantity;
    count += item.quantity;
  }
  if (count > 10) {
    total = total * 0.95;
  } else {
    total = total + 1;
  }
  return round(total * 100) / 100;
}

export class Cart {
  currency = 'EUR';

  total(items: Item[], discount: Discount): number {
    const amount = subtotal(items, this.limit);
    const rate = discount.rate;
    let reduced = amount - amount * rate;
    if (reduced < 0) {
      reduced = 0;
    }
    return round(reduced, 2);
  }
}
`,
};

export const MUTATION_FIXTURES: readonly MutationFixture[] = [PY_FIXTURE, TS_FIXTURE];
