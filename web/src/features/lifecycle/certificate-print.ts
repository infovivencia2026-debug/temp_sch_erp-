/* A STUDENT CERTIFICATE, AS PRINTED (owner, 2026-10-07: "let them add the
   design of the certificate"). One A4 page in Inter, in the style the school
   chose for that certificate:

     classic     a double ruled border, the school centred at the top, the
                 title in spaced capitals, a seal circle beside the signature
     letterhead  the plain office letterhead every other print uses
     background  the school's own printed design as the page background (an
                 uploaded scan of their certificate stationery); only the
                 words and the signature are printed on top of it

   The words come from the school's wording (Certificate designs → wording) or
   the standard text for that certificate. */

export interface CertificateRender {
  title: string; code: string; serial_no: string; issued_on: string
  signatory: string; signatory_role: string
  body: string | null
  design?: { style?: string; background_file_id?: string | null; signature_file_id?: string | null } | null
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
/* The wording is HTML a clerk typed; the print frame shares this page's origin,
   so nothing that can run is let through. */
function clean(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  doc.querySelectorAll('script, iframe, object, embed, link, meta, base, form').forEach((n) => n.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /^s*javascript:/i.test(a.value)) el.removeAttribute(a.name)
    }
  })
  return doc.body.firstElementChild?.innerHTML ?? ''
}
const file = (id?: string | null) => (id ? `${location.origin}/api/v1/files/${id}?inline=1` : '')

export function certificateHtml(r: CertificateRender, o: { school: string; logoUrl?: string; address?: string }): string {
  const style = r.design?.style === 'letterhead' || r.design?.style === 'background' ? r.design.style : 'classic'
  const bg = style === 'background' ? file(r.design?.background_file_id) : ''
  const sig = file(r.design?.signature_file_id)
  const logo = o.logoUrl ? `<img class="logo" src="${esc(o.logoUrl)}" alt="">` : ''
  const signature = `<div class="sign">
    <div class="when"><span>Date of issue</span><b>${esc(r.issued_on)}</b></div>
    ${style === 'classic' ? '<div class="seal">SEAL</div>' : ''}
    <div class="sig">${sig ? `<img src="${esc(sig)}" alt="">` : '<div class="space"></div>'}<div class="line"></div><b>${esc(r.signatory || 'Principal')}</b><span>${esc(r.signatory_role || 'Principal')}</span></div>
  </div>`
  const head = style === 'background' && bg ? '<div class="bg-space"></div>'
    : style === 'letterhead'
      ? `<div class="lh">${logo}<div><h1>${esc(o.school)}</h1>${o.address ? `<p>${esc(o.address)}</p>` : ''}</div></div><div class="rule"></div>`
      : `<div class="crest">${logo}<h1>${esc(o.school)}</h1>${o.address ? `<p>${esc(o.address)}</p>` : ''}</div>`
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(r.title)} · ${esc(r.serial_no)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap"><style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; height: 297mm; position: relative; padding: ${style === 'classic' ? '20mm 22mm' : '18mm 20mm'}; display: flex; flex-direction: column; overflow: hidden;
  ${bg ? `background: url('${esc(bg)}') center / 100% 100% no-repeat;` : ''} }
.frame { position: absolute; inset: 9mm; border: 2.5px solid #7f1d1d; pointer-events: none; }
.frame::after { content: ''; position: absolute; inset: 4px; border: 1px solid #b45309; }
.crest { text-align: center; margin-top: 6mm; }
.crest .logo { width: 70px; height: 70px; object-fit: contain; margin-bottom: 8px; }
.crest h1 { font-size: 24px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; color: #7f1d1d; }
.crest p, .lh p { font-size: 11.5px; color: #64748b; margin-top: 3px; }
.lh { display: flex; align-items: center; gap: 16px; padding-bottom: 14px; } .lh .logo { width: 58px; height: 58px; object-fit: contain; }
.lh h1 { font-size: 22px; font-weight: 700; letter-spacing: -.4px; } .rule { height: 3px; background: #c22525; margin-bottom: 18px; }
.bg-space { height: 62mm; }
.meta { display: flex; justify-content: space-between; font-size: 11.5px; color: #475569; margin: ${style === 'classic' ? '14mm 0 10mm' : '0 0 14mm'}; } .meta b { color: #0f172a; font-weight: 600; }
.title { text-align: center; font-size: ${style === 'classic' ? '22px' : '19px'}; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 4px; }
.title-rule { width: 70mm; height: 2px; background: ${style === 'classic' ? '#b45309' : '#c22525'}; margin: 8px auto 12mm; }
.body { font-size: 13.5px; line-height: 1.85; color: #1e293b; }
.body p { margin-bottom: 12px; } .body strong, .body b { font-weight: 600; }
.body table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.5; margin-top: 6px; }
.body td { border-bottom: 1px solid #e5e7eb; padding: 6px 6px; vertical-align: top; }
.spacer { flex: 1; }
.sign { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 18mm; }
.when { font-size: 11.5px; color: #475569; display: flex; flex-direction: column; gap: 2px; } .when b { color: #0f172a; font-weight: 600; font-size: 12.5px; }
.seal { width: 26mm; height: 26mm; border-radius: 50%; border: 1.5px dashed #94a3b8; display: grid; place-items: center; font-size: 9px; letter-spacing: .2em; color: #94a3b8; }
.sig { width: 62mm; text-align: center; font-size: 12px; } .sig img { height: 16mm; max-width: 100%; object-fit: contain; display: block; margin: 0 auto -2mm; } .sig .space { height: 14mm; }
.sig .line { border-top: 1px solid #334155; margin-bottom: 6px; } .sig b { display: block; font-weight: 600; } .sig span { font-size: 11px; color: #64748b; }
</style></head><body><div class="page">${style === 'classic' ? '<div class="frame"></div>' : ''}
${head}
<div class="meta"><div>Certificate No: <b>${esc(r.serial_no)}</b></div><div>Date: <b>${esc(r.issued_on)}</b></div></div>
<div class="title">${esc(r.title)}</div><div class="title-rule"></div>
<div class="body">${clean(r.body ?? '')}</div>
<div class="spacer"></div>
${signature}
</div></body></html>`
}
