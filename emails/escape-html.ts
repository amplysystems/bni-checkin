// Escapes person-supplied text (visitor/member names, industries,
// companies, contact info — anything typed into the kiosk visitor form or
// the admin roster) before it's interpolated into an HTML email template.
// Without this, a visitor named e.g. `<img src=x onerror=...>` would
// render as live markup in Gmail/Apple Mail/Outlook rather than as literal
// text. Deliberately NOT applied to subject lines (Resend subjects are
// plain text, not an HTML context) or to the .txt template variants (also
// plain text — escaping there would show literal "&amp;" to the reader).
//
// `&` first, always — otherwise the entities this function just introduced
// (&lt; etc.) would themselves get re-escaped into &amp;lt;.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
