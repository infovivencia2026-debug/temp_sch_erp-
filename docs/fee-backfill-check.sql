-- Read-only checks for migration 0136_fee_line_allocations on a school D1.
-- 1) Run A and A2 BEFORE the migration; save output. 2) Run them AFTER; output must be identical.
-- 3) After: B and C must return no rows, and negative_rows = 0.

-- A. Every receipt: number, amount, status, total allocated.
SELECT p.id, p.receipt_no, p.amount_paise, p.status,
       COALESCE((SELECT sum(a.amount_paise) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS allocated
  FROM payments p ORDER BY p.id;

-- A2. Every student: charged, paid, balance.
SELECT s.id, s.admission_no,
       COALESCE((SELECT sum(i.net_paise) FROM invoices i WHERE i.student_id = s.id AND i.status <> 'cancelled'), 0) AS charged,
       COALESCE((SELECT sum(p.amount_paise) FROM payments p WHERE p.student_id = s.id AND p.status = 'success'), 0) AS paid,
       COALESCE((SELECT sum(i.net_paise - i.paid_paise) FROM invoices i WHERE i.student_id = s.id AND i.status <> 'cancelled'), 0) AS balance
  FROM students s ORDER BY s.id;

-- B. After: allocations whose fee-line rows do not add up (expect none).
SELECT a.id, a.payment_id, a.amount_paise,
       (SELECT COALESCE(sum(x.amount_paise), 0) FROM payment_line_allocations x WHERE x.payment_allocation_id = a.id) AS lines_sum
  FROM payment_allocations a
 WHERE a.amount_paise <> (SELECT COALESCE(sum(x.amount_paise), 0) FROM payment_line_allocations x WHERE x.payment_allocation_id = a.id);

-- C. After: fee lines paid beyond their amount (expect none), and no negative rows.
SELECT il.id, max(il.amount_paise - il.discount_paise, 0) AS net,
       (SELECT sum(x.amount_paise) FROM payment_line_allocations x WHERE x.invoice_line_id = il.id) AS paid
  FROM invoice_lines il
 WHERE (SELECT COALESCE(sum(x.amount_paise), 0) FROM payment_line_allocations x WHERE x.invoice_line_id = il.id) > max(il.amount_paise - il.discount_paise, 0);
SELECT count(*) AS negative_rows FROM payment_line_allocations WHERE amount_paise <= 0;
