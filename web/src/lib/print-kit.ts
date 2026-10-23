/* ONE LOOK FOR EVERY PRINT (owner, 2026-10-07: "like this all should be",
   pointing at the seating plan from the shared print engine).

   The engine's look: the count figures in one rounded box with grey labels
   over big numbers, and every table in its own rounded card with grey
   capital headings. The hand-built prints (leave, fee overview, fee
   collection, staff report) drew ruled black boxes instead; appending this to
   their stylesheet brings them in line without rewriting each one. */
export const PRINT_KIT_CSS = `
table.counts { border: 1px solid #e2e8f0 !important; border-radius: 12px; border-collapse: separate !important; border-spacing: 0; overflow: hidden; background: #fff; }
table.counts td { border: 0 !important; text-align: left !important; padding: 16px 20px !important; vertical-align: top; }
table.counts .bl { background: none !important; border: 0 !important; padding: 0 !important; font-size: 10.5px !important; letter-spacing: .06em; color: #64748b !important; }
table.counts .bv { padding: 6px 0 0 !important; font-size: 24px !important; font-weight: 700; }
table.counts .bc { padding: 3px 0 0 !important; color: #64748b !important; }
table.list { border: 1px solid #e2e8f0; border-radius: 12px; border-collapse: separate !important; border-spacing: 0; overflow: hidden; }
table.list th { background: #f8fafc !important; color: #64748b !important; border-bottom: 1px solid #e2e8f0 !important; padding: 10px 12px !important; }
table.list td { padding: 10px 12px !important; }
table.list tr:last-child td { border-bottom: 0 !important; }
table.list tr.total td { border-bottom: 0 !important; }
h3 { color: #0f172a; font-size: 13px !important; letter-spacing: 0 !important; text-transform: none !important; font-weight: 600 !important; margin: 0 0 8px 2px !important; }
`
