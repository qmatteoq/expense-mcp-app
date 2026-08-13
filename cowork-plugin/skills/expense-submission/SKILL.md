---
name: expense-submission
description: |
  Submits business expenses to the Contoso expense system and reviews recently
  submitted ones. Use when the user asks to "submit an expense", "file an expense",
  "expense this receipt", "log a business expense", "add this to my expense report",
  "what expenses did I submit", or "show my recent expenses".
license: MIT
metadata:
  author: Contoso Expenses
  version: "1.0"
---

# Expense Submission

## What This Skill Does

Turns a receipt, an invoice, or a plain description of a purchase into a
correctly categorized expense in the Contoso expense system, and reports back
what was recorded.

## Available Tools

- **`submitExpense`** — creates one expense. Parameters: `merchant`, `amount`,
  `currency` (ISO code, defaults to `EUR`), `category`, `date` (`YYYY-MM-DD`).
- **`listExpenses`** — returns recent expenses. Optional `limit` (1–50, default 5).

## Workflow

1. Gather the expense details from the user's message and from any attached
   receipt, invoice, or email in the workspace.
2. Map the purchase to exactly one category: `Travel`, `Meals`, `Lodging`,
   `Supplies`, or `Other`. See `references/expense-categories.md` for the
   mapping rules.
3. Normalize the values before calling the tool:
   - `amount` is a positive number with no currency symbol and no thousands separator.
   - `currency` is an ISO 4217 code (`EUR`, `USD`, `GBP`, …).
   - `date` is `YYYY-MM-DD`. Use the date the expense was incurred, not today's date.
4. If the merchant, amount, or date is missing or ambiguous, ask the user for
   that specific value. Never guess an amount or a date.
5. Call `submitExpense` once per expense. For a receipt containing several
   distinct expenses (for example a hotel folio with room charges and meals),
   call it once per line item rather than submitting one lump sum.
6. Confirm back to the user with the returned expense id and a summary table.
7. When the user asks what has been filed, call `listExpenses` and present the
   results as a table.

## Output Format

After a submission:

> Submitted 1 expense.

| Expense ID | Date | Merchant | Category | Amount |
|------------|------|----------|----------|--------|
| exp_0100 | 2026-05-04 | Lufthansa | Travel | 312.40 EUR |

When listing expenses, use the same table without a leading sentence, ordered
most recent first.

## Rules

- Never invent a merchant, amount, or date that is not present in the source
  material or supplied by the user.
- Do not submit the same expense twice. If the user repeats a request, call
  `listExpenses` first and check for a matching merchant, amount, and date.
- Keep amounts in their original currency. Do not convert currencies.
- Round amounts to two decimal places.

## Additional Resources

- **`references/expense-categories.md`** — category definitions and mapping rules.
