// utils/phone.js
// Un seul format pour tous les numéros : 0XXXXXXXXX.
// (La même fonction existe côté site : front/src/utils/phone.js.)

/* Met un numéro algérien au format unique.
   Accepte espaces, points, tirets, parenthèses, les indicatifs +213 / 00213 /
   213 et les chiffres arabes. Un numéro qu'on ne sait pas interpréter est
   rendu nettoyé de ses séparateurs, sans rien inventer : on ne refuse jamais
   une commande pour une question de présentation. */
function normalizePhone(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return ''

  // Chiffres arabes (٠-٩) et persans (۰-۹) → chiffres latins
  s = s.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
       .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06F0))

  let d = s.replace(/\D/g, '')
  if (!d) return s                    // aucun chiffre : on laisse tel quel

  // Indicatif international
  let intl = false
  if (d.startsWith('00213'))                       { d = d.slice(5); intl = true }
  else if (d.startsWith('213') && d.length >= 11)  { d = d.slice(3); intl = true }

  // Après l'indicatif, ou saisi sans le 0 : 551234567 → 0551234567
  if (!d.startsWith('0') && (intl || (d.length === 9 && /^[5-7]/.test(d)))) d = '0' + d
  return d
}

module.exports = { normalizePhone }
