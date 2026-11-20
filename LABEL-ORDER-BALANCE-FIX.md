# Label-Based Auto Order — the rule, and what was wrong

## The rule (billing/buyer/label-order.html)
Every printed label is taken off **Stock Now** first. Then:

    Balance to Order = −(Stock Now) − (already on order, not yet accepted)      never below 0

| Stock before | Labels | Stock Now | Order |
|---|---|---|---|
| 10  | 100 | −90  | **90**  |
| −10 | 100 | −110 | **110** |
| 0   | 100 | −100 | **100** |
| 150 | 100 | 50   | none (covered by stock) |

When the seller accepts, the ordered quantity is added back → stock is exactly **0**.

## Problems found and fixed
1. **Orders waiting for the seller were ignored** → the same shortfall was ordered twice, the seller accepted both,
   stock ended too high, and the next order came out far too small (262 labels → 8). Now units already on order
   are counted (new "On order" column).
2. **Stock and draft could get out of step.** A label was added to the draft first and its stock deducted second; if the
   page closed/failed part-way through a big upload, the label stayed in the draft with its stock never deducted, and
   re-uploading skipped it. Now stock is deducted first and both steps are repeat-safe: **upload the same file again
   and it repairs itself** ("N were already in the summary but their stock had not been deducted — fixed").
3. The order is built from the **latest** stock and pending orders, not what the page loaded earlier.
4. **✎ next to Stock Now** corrects a figure that is already wrong (logged as a manual adjustment).
5. The earlier "Keep my stock at zero" switch was REMOVED — it ordered the full dispatched quantity and wiped real
   stock (stock 10 + 100 labels gave 100, not 90).

## Tested end to end (100 labels through the real upload path → deduction → draft → order → seller accepts)
stock 10 → order 90 · stock −10 → order 110 · stock 0 → order 100 · all end at stock 0 after acceptance ·
stock 150 → no order · interrupted upload is repaired and never double-counts.

Upload: billing/buyer/label-order.html (full file). No database change.
