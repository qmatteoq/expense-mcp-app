# Expense Categories

The expense form accepts exactly one of five categories. Use this mapping when
classifying a receipt to prefill `openExpenseForm`. If the mapping is not clear,
leave the category unset and let the user pick it in the form.

## Travel

Transport that moves the traveler between locations.

- Airfare, rail tickets, ferries
- Taxi, rideshare, public transport
- Car rental, fuel for a rental car, road tolls, parking
- Mileage reimbursement claims
- Visa and travel insurance fees

Typical merchants: airlines, rail operators, Uber, Hertz, parking operators.

## Lodging

Overnight accommodation and charges billed by the accommodation provider.

- Hotel room rate and associated city or tourist taxes
- Short-term rental accommodation
- Hotel internet or laundry charges billed to the room

Room service and restaurant charges on a hotel folio are **Meals**, not
Lodging. Split the folio into separate expenses.

Typical merchants: hotel chains, Airbnb, booking platforms.

## Meals

Food and drink, whether for the employee alone or for a business meal.

- Restaurant meals, cafes, bars
- Per-diem meal claims
- Client entertainment meals
- Catering for a business meeting

Grocery purchases for a team event are Meals. Grocery purchases for personal
consumption are not reimbursable and should not be submitted.

Typical merchants: restaurants, coffee shops, catering companies.

## Supplies

Goods and services consumed while doing the work.

- Office supplies, stationery, printing
- Software licenses and SaaS subscriptions
- Books, training materials, conference and event fees
- Small hardware and accessories below the capitalization threshold

Typical merchants: office retailers, software vendors, conference organizers.

## Other

Anything that does not fit the four categories above.

- Bank or currency-conversion fees on a business transaction
- Shipping and courier charges
- Professional membership dues

When using `Other`, make the merchant name descriptive enough that a reviewer
can tell what was purchased.

## Ambiguity Rules

1. If a receipt could fall into two categories, choose the one describing the
   **primary purpose** of the purchase.
2. If a single receipt mixes categories (a hotel folio, a travel agency invoice),
   split it into one expense per category.
3. If the category is genuinely unclear, ask the user rather than defaulting
   to `Other`.
