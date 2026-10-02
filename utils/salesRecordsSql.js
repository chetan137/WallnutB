'use strict';

/**
 * services/salesRecordsSql.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The SQL behind the dashboard's flat sales rows (one per voucher × item line).
 *
 * ⚠️  tallybackend/utils/salesRecordsSql.js is a byte-for-byte COPY of this file
 *     (tallybackend has its own repo and runs on the VM, where verify_net_sales.js
 *     uses it to check the numbers against Tally before this backend is deployed).
 *     Change both together.
 *
 * WHY LEDGER POSTINGS, NOT ITEM LINES
 * Tally's "Sales" (P&L / mobile dashboard) is the net of every posting to the
 * ledgers of the "Sales Accounts" group; "Branch Trf-Sales" is a separate group
 * that Tally keeps out of Sales. Verified on both companies (reconcile_sales_ledgers.js,
 * diagnose_sales_by_type.js): the postings of all voucher types add up to Tally's P&L
 * to within 0.01% (FY 24-25: 8,94,20,345 vs 8,94,31,810; Branch exactly), while the old
 * figure — the sum of item-line amounts of Sales + Credit Note vouchers — was 3-20 lakh a
 * month higher (credit notes were added, not subtracted).
 *
 * Per voucher (Sales, Credit Note and Debit Note types — the only types that post to
 * these groups in this data). "Sales Order…" types (Proforma Invoices, e.g. "Sales Order_Kol")
 * are EXCLUDED even though their names start with "Sales": a Sales Order is a non-accounting
 * document in Tally (no ledger posting, nothing in the P&L), but the Voucher Register still
 * returns it with sales ledger lines — counted, they put Sep-2026 40 lakh above Tally:
 *
 *   category  branch_transfer  has a posting in a "Branch Trf…Sales" group ledger
 *             sample           voucher type "Promotional Invoice", or a free-goods
 *                              ledger (Free Gift / Free Promotional Iteam /
 *                              Sample Sale / Free Sample / Free Samples -Customer)
 *             sale             has a posting in a "Sales Accounts" group ledger
 *             other            posts to neither group: NOT sales in Tally, so it is
 *                              dropped (no item-total fallback — that fallback added
 *                              ~80 lakh of non-sales vouchers to FY 24-25)
 *   voucher amount (excl. GST)
 *             sale             Σ postings to "Sales Accounts" ledgers — credit notes come
 *                              out negative, debit notes positive, as in Tally
 *             branch_transfer  Σ postings to the "Branch Trf…Sales" ledgers
 *             sample           item total (display only)
 *   The voucher amount is spread over its item lines in proportion to each line's
 *   amount, so item / dealer / officer / state breakdowns still add up to it.
 *   Quantity of a net-negative voucher (a credit note) is negative.
 *
 * DEALER PLACE: state / district / city / pincode come from the dealer's ledger pincode
 * (dealer_loc CTE), not from the plant. Rows of dealers without a mapped pincode keep the
 * old state and have an empty district / city.
 */

/**
 * @param {{ companyFilter?: string, dateFilter?: string }} filters
 *   SQL fragments that start with " AND …" and use the alias "v" (vouchers),
 *   with $n placeholders the caller supplies.
 * @returns {string}
 */
function buildSalesRecordsSql({ companyFilter = '', dateFilter = '' } = {}) {
  return `
    WITH dealer_loc AS (
      -- Dealer's real place, from the pincode on the Tally ledger master (pincode_locations is
      -- filled by tallybackend/sync_pincode_locations.js). One row per dealer name; the latest
      -- company that has a pincode wins.
      SELECT DISTINCT ON (l.name) l.name,
             REGEXP_REPLACE(l.pincode, '[[:space:]]', '', 'g') AS pincode,
             pl.state, pl.district, pl.city
      FROM ledgers l
      JOIN pincode_locations pl ON pl.pincode = REGEXP_REPLACE(l.pincode, '[[:space:]]', '', 'g')
      ORDER BY l.name, l.company_id DESC
    ),
    voucher_ledger AS (
      SELECT e.voucher_id,
             SUM(e.amount) FILTER (WHERE l.parent_group = 'Sales Accounts')        AS sales_amt,
             SUM(e.amount) FILTER (WHERE l.parent_group ILIKE 'Branch Trf%Sales%') AS branch_amt
      FROM voucher_ledger_entries e
      JOIN vouchers v ON v.id = e.voucher_id
      JOIN ledgers  l ON l.company_id = v.company_id AND l.name = e.ledger_name
      WHERE v.is_cancelled = false
        AND ((LOWER(v.vch_type) LIKE 'sales%' AND LOWER(v.vch_type) NOT LIKE 'sales order%') OR LOWER(v.vch_type) LIKE 'credit note%' OR LOWER(v.vch_type) LIKE 'debit note%')
        ${companyFilter}
        ${dateFilter}
      GROUP BY e.voucher_id
    ),
    voucher_category AS (
      SELECT b.*,
             CASE b.category
               WHEN 'branch_transfer' THEN b.branch_amt
               WHEN 'sample'          THEN COALESCE(b.item_total, b.total_amount)
               WHEN 'sale'            THEN b.sales_amt
               ELSE 0
             END AS v_amt
      FROM (
        SELECT v.id, v.vch_type, v.total_amount,
               vl.sales_amt, vl.branch_amt, vi.item_total, vi.item_count,
               CASE
                 WHEN vl.branch_amt IS NOT NULL THEN 'branch_transfer'
                 WHEN v.vch_type ILIKE 'promotional invoice%'
                      OR EXISTS (
                        SELECT 1 FROM voucher_ledger_entries e
                        WHERE e.voucher_id = v.id
                          AND e.ledger_name ILIKE ANY (ARRAY['free gift%', 'free promotional%', 'free sample%', 'sample sale%'])
                      )
                   THEN 'sample'
                 WHEN vl.sales_amt IS NOT NULL THEN 'sale'
                 ELSE 'other'
               END AS category
        FROM vouchers v
        LEFT JOIN voucher_ledger vl ON vl.voucher_id = v.id
        LEFT JOIN LATERAL (
          SELECT SUM(x.amount) AS item_total, COUNT(*) AS item_count
          FROM voucher_inventory_entries x WHERE x.voucher_id = v.id
        ) vi ON true
        WHERE v.is_cancelled = false
          AND ((LOWER(v.vch_type) LIKE 'sales%' AND LOWER(v.vch_type) NOT LIKE 'sales order%') OR LOWER(v.vch_type) LIKE 'credit note%' OR LOWER(v.vch_type) LIKE 'debit note%')
          ${companyFilter}
          ${dateFilter}
      ) b
    )
    SELECT
      v.vch_no                                        AS "vchNo",
      v.date                                           AS "date",
      v.vch_type                                       AS "vchType",
      vc.category                                      AS "invoiceCategory",
      v.party_name                                     AS "partyName",
      -- tallybackend used to fabricate an item name from free-text narration
      -- when a voucher had no real inventory line (fixed there in commit
      -- cd73651, but rows synced before that fix still carry the garbage —
      -- e.g. "Being Credit note raised for Exhibition done at..."). Blank
      -- it out here rather than dropping the row, so the real amount still
      -- counts toward revenue — only the (never-valid) item label is lost.
      CASE WHEN vie.item_name ILIKE 'Being %' OR vie.item_name ILIKE '(Being%' OR vie.item_name ILIKE 'Being'
           THEN NULL ELSE vie.item_name END              AS "itemName",
      COALESCE(vie.quantity, 0) * CASE WHEN vc.v_amt < 0 THEN -1 ELSE 1 END AS "quantity",
      vie.unit                                         AS "units",
      COALESCE(vie.rate, 0)                            AS "rate",
      -- Voucher amount spread over its item lines (see the header comment).
      CASE
        WHEN vie.id IS NULL                      THEN vc.v_amt
        WHEN COALESCE(vc.item_total, 0) <> 0     THEN vc.v_amt * COALESCE(vie.amount, 0) / vc.item_total
        ELSE vc.v_amt / NULLIF(vc.item_count, 0)
      END                                              AS "amount",
      COALESCE(vie.sales_officer, '')                  AS "salesMan",
      COALESCE(vie.area_city, '')                      AS "areaCity",
      -- Dealer's place from the pincode first; the old plant / ledger state only when no pincode.
      COALESCE(NULLIF(dl.state, ''), NULLIF(vie.state, ''), l.state, '') AS "state",
      COALESCE(dl.district, '')                        AS "district",
      COALESCE(dl.city, '')                            AS "city",
      COALESCE(dl.pincode, '')                         AS "pincode",
      TO_CHAR(br.due_date, 'YYYY-MM-DD')               AS "billDueDate",
      COALESCE(si.parent_group, '')                    AS "stockGroup",
      COALESCE(si.parent_group, '')                    AS "stockCategory",
      -- BUG FIX: bills_receivable is bill-level (one row per bill), but this
      -- query is at (voucher x inventory-line) grain — a voucher with N
      -- line items joined the SAME br.amount onto all N rows, so summing
      -- finalOutstanding over any scope multiplied every bill's amount by
      -- however many line items its voucher had (avg ~2.8x for this data,
      -- verified against a direct bills_receivable total: the old query
      -- summed to 5x the real figure for company 1). Attribute the full
      -- amount to only the first line of each voucher (by vie.id) so a SUM
      -- across rows counts each bill exactly once, matching bills_receivable.
      CASE WHEN ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY vie.id) = 1
           THEN COALESCE(br.amount, 0) ELSE 0 END        AS "finalOutstanding"
    FROM vouchers v
    JOIN voucher_category vc ON vc.id = v.id
    LEFT JOIN voucher_inventory_entries vie ON vie.voucher_id = v.id
    LEFT JOIN stock_items si
      ON si.company_id = v.company_id AND si.name = vie.item_name
    LEFT JOIN bills_receivable br
      ON br.company_id = v.company_id AND br.party_name = v.party_name AND br.bill_ref = v.vch_no
    LEFT JOIN ledgers l
      ON l.company_id = v.company_id AND l.name = v.party_name
    LEFT JOIN dealer_loc dl ON dl.name = v.party_name
    ORDER BY v.date DESC
  `;
}

module.exports = { buildSalesRecordsSql };
