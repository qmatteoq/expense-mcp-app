---
name: expense-submission
description: |
  Submits business expenses to the Contoso expense system and reviews recently
  submitted ones. Opens an interactive form for the user to fill in rather than
  asking for details in chat. Use when the user asks to "submit an expense",
  "file an expense", "expense this receipt", "log a business expense", "add this
  to my expense report", "what expenses did I submit", or "show my recent expenses".
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

- **`openExpenseForm`** — opens the interactive expense form for the user to fill
  in. Takes no required parameters. All parameters (`merchant`, `amount`,
  `currency`, `category`, `date`) are optional *prefill* values.
- **`listExpenses`** — returns recent expenses. Optional `limit` (1–50, default 5).

`submitExpense` exists but is called by the form widget itself, not by you.

## Workflow

1. When the user wants to submit, file, add, or log an expense, call
   **`openExpenseForm` right away**. Do not ask for the merchant, amount,
   currency, category, or date first — the form collects them, and asking first
   duplicates work the user is about to do in the UI.
2. Pass through anything the user already mentioned as prefill. If they said
   "expense my 42 euro taxi from yesterday", prefill `amount`, `currency`,
   `category`, and `date`. Omit whatever they did not say; never guess a value
   to fill a field.
3. Use any attached receipt, invoice, or email in the workspace as a source of
   prefill values too, applying the same rule: prefill what the document states,
   leave the rest blank.
4. Map the purchase to exactly one category: `Travel`, `Meals`, `Lodging`,
   `Supplies`, or `Other`. See `references/expense-categories.md` for the
   mapping rules. If the category is not clear, leave it unset rather than
   guessing — the user picks it in the form.
5. Normalize any prefill values before passing them:
   - `amount` is a positive number with no currency symbol and no thousands separator.
   - `currency` is an ISO 4217 code (`EUR`, `USD`, `GBP`, …).
   - `date` is `YYYY-MM-DD`. Use the date the expense was incurred, not today's date.
6. After opening the form, stop and let the user submit it. Do not announce that
   an expense was recorded — nothing is recorded until they click Submit, and the
   widget reports the result itself.
7. For a receipt containing several distinct expenses (for example a hotel folio
   with room charges and meals), open the form once per line item rather than
   combining them into one lump sum.
8. When the user asks what has been filed, call `listExpenses` and present the
   results as a table.

## Output Format

The form widget reports its own result when the user submits, so do not repeat
it. Only summarize when the user asks what has been filed:

| Expense ID | Date | Merchant | Category | Amount |
|------------|------|----------|----------|--------|
| exp_0100 | 2026-05-04 | Lufthansa | Travel | 312.40 EUR |

When listing expenses, order most recent first.

## Rules

- Never invent a merchant, amount, or date that is not present in the source
  material or supplied by the user. Leave the field blank in the form instead.
- Do not ask the user for expense details in chat. Open the form and let them
  fill it in.
- Do not claim an expense was submitted just because you opened the form. The
  user has to submit it.
- Do not open the form twice for the same expense. If the user repeats a
  request, call `listExpenses` first and check for a matching merchant, amount,
  and date.
- Keep amounts in their original currency. Do not convert currencies.
- Round amounts to two decimal places.

## Additional Resources

- **`references/expense-categories.md`** — category definitions and mapping rules.
