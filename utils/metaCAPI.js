/**
 * metaCAPI.js — Meta Conversions API (server-side)
 *
 * Envoie les événements directement à Meta depuis le serveur,
 * avec les données utilisateur hashées en SHA256 pour améliorer
 * le matching (Advanced Matching).
 *
 * Variables d'environnement requises (.env) :
 *   META_PIXEL_ID       → ID du Pixel Meta
 *   META_ACCESS_TOKEN   → Token d'accès CAPI (System User Access Token)
 *
 * CHANGELOG :
 *  ✅ FIX  — Mapping géographique Algérie corrigé : st=wilaya (state/province), ct=commune (city)
 *            L'ancien mapping (ct=wilaya, zp=commune) était incorrect pour Meta
 *  ✅ NEW  — Champs fbp / fbc (cookies Meta) ajoutés au buildUserData pour meilleur matching
 */

const https  = require('https')
const crypto = require('crypto')

const PIXEL_ID     = process.env.META_PIXEL_ID
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN
const CAPI_VERSION = 'v19.0'

/* ─────────────────────────────────────────────
   Hashage SHA256 d'une valeur normalisée
   Meta exige : trim + lowercase avant hash
───────────────────────────────────────────────*/
function sha256(value) {
  if (!value) return undefined
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex')
}

/* ─────────────────────────────────────────────
   Normalise un numéro de téléphone algérien
   Meta attend le format E.164 : +213XXXXXXXXX
───────────────────────────────────────────────*/
function normalizePhone(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  // 0551234567 → 213551234567
  if (digits.startsWith('0')) return '213' + digits.slice(1)
  // Déjà préfixé 213
  if (digits.startsWith('213')) return digits
  return digits
}

/* ─────────────────────────────────────────────
   Construit l'objet user_data avec tous les
   champs hashés disponibles.

   Mapping géographique Algérie (CORRIGÉ) :
   - st (state)  = wilaya   ← province / région
   - ct (city)   = commune  ← ville
   Note : zp (zip code) supprimé — pas de code
   postal standardisé en Algérie.
───────────────────────────────────────────────*/
function buildUserData({ phone, firstName, lastName, wilaya, commune, ip, userAgent, fbp, fbc } = {}) {
  const userData = {}

  if (phone)      userData.ph  = sha256(normalizePhone(phone))
  if (firstName)  userData.fn  = sha256(firstName)
  if (lastName)   userData.ln  = sha256(lastName)
  if (wilaya)     userData.st  = sha256(wilaya)   // st = state/province → wilaya ✓
  if (commune)    userData.ct  = sha256(commune)  // ct = city → commune ✓
  userData.country             = sha256('dz')     // Algérie toujours

  // Non hashés (Meta les accepte en clair pour ces champs)
  if (ip)         userData.client_ip_address  = ip
  if (userAgent)  userData.client_user_agent  = userAgent

  // Cookies Meta — non hashés, améliorent le matching cross-device
  if (fbp)        userData.fbp = fbp
  if (fbc)        userData.fbc = fbc

  return userData
}

/* ─────────────────────────────────────────────
   Envoi HTTP à l'API Graph de Meta
───────────────────────────────────────────────*/
function postToMeta(payload) {
  return new Promise((resolve, reject) => {
    if (!PIXEL_ID || !ACCESS_TOKEN) {
      console.warn('⚠️  META_PIXEL_ID ou META_ACCESS_TOKEN manquant — CAPI désactivé')
      return resolve(null)
    }

    const body = JSON.stringify(payload)
    const path = `/${CAPI_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`

    const options = {
      hostname: 'graph.facebook.com',
      path,
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }

    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) {
            console.error('❌ Meta CAPI error:', parsed.error)
          } else {
            console.log(`✅ Meta CAPI [${payload.data?.[0]?.event_name}] envoyé — events_received: ${parsed.events_received}`)
          }
          resolve(parsed)
        } catch {
          resolve(data)
        }
      })
    })

    req.on('error', err => {
      console.error('❌ Meta CAPI request error:', err.message)
      resolve(null) // On ne rejette pas — le tracking ne doit jamais bloquer la commande
    })

    req.write(body)
    req.end()
  })
}

/* ════════════════════════════════════════════
   FONCTION PRINCIPALE
   sendMetaEvent(eventName, options)
════════════════════════════════════════════ */

/**
 * @param {string} eventName   - 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Lead' | 'AddPaymentInfo' | 'Purchase' | 'DeliveredOrder'
 * @param {object} options
 * @param {string} options.eventId          - event_id unique (déduplication avec Pixel)
 * @param {string} options.sourceUrl        - URL de la page
 * @param {object} options.userData         - données brutes (non hashées, on hash ici)
 * @param {object} options.customData       - données e-commerce (value, currency, content_ids…)
 */
async function sendMetaEvent(eventName, { eventId, sourceUrl, userData = {}, customData = {} } = {}) {
  const payload = {
    data: [
      {
        event_name:       eventName,
        event_time:       Math.floor(Date.now() / 1000),
        event_id:         eventId,
        event_source_url: sourceUrl || '',
        action_source:    'website',
        user_data:        buildUserData(userData),
        custom_data:      customData,
      },
    ],
    //test_event_code: 'TEST50771', // ← décommentez pendant les tests Meta Events Manager
  }

  return postToMeta(payload)
}

module.exports = { sendMetaEvent }