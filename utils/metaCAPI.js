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
const CAPI_VERSION = 'v21.0'

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
  let digits = String(phone).replace(/\D/g, '')
  // 00213551234567 → 213551234567 (préfixe international écrit « 00 »)
  if (digits.startsWith('00')) digits = digits.slice(2)
  // Déjà préfixé 213
  if (digits.startsWith('213')) return digits
  // 0551234567 → 213551234567
  if (digits.startsWith('0')) return '213' + digits.slice(1)
  // 551234567 (9 chiffres, sans le 0) → 213551234567
  if (digits.length === 9 && /^[567]/.test(digits)) return '213' + digits
  return digits
}

/* ─────────────────────────────────────────────
   Normalisations exigées par Meta AVANT hachage.
   Un haché ne correspond que si la valeur est écrite exactement comme Meta
   l'attend : « Sidi Bel Abbès » ou « M'Sila » hachés tels quels ne sont
   jamais reconnus.
   - ville / région : minuscules, sans espace ni ponctuation
   - nom / prénom   : minuscules, sans ponctuation
   Les lettres de tous les alphabets (accents, arabe) sont conservées.
───────────────────────────────────────────────*/
function normalizeGeo(value) {
  return String(value).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}
function normalizeName(value) {
  return String(value).normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
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
  if (firstName)  userData.fn  = sha256(normalizeName(firstName))
  if (lastName)   userData.ln  = sha256(normalizeName(lastName))
  if (wilaya)     userData.st  = sha256(normalizeGeo(wilaya))   // st = state/province → wilaya ✓
  if (commune)    userData.ct  = sha256(normalizeGeo(commune))  // ct = city → commune ✓
  userData.country             = sha256('dz')     // Algérie toujours

  // Non hashés (Meta les accepte en clair pour ces champs)
  if (ip)         userData.client_ip_address  = ip
  if (userAgent)  userData.client_user_agent  = userAgent

  // Cookies Meta — non hashés, améliorent le matching cross-device
  if (fbp)        userData.fbp = fbp
  if (fbc)        userData.fbc = fbc

  return userData
}

/* Dernière réponse de Meta, exposée par /health. Un token présent mais
   expiré ou révoqué ne se voit nulle part ailleurs : Meta refuse, on
   journalise, et le tracking serveur est mort sans que personne le sache. */
let dernierEnvoi = null
const getDernierEnvoi = () => dernierEnvoi

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
        const eventName = payload.data?.[0]?.event_name
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) {
            console.error('❌ Meta CAPI error:', parsed.error)
            dernierEnvoi = {
              at: new Date().toISOString(), evenement: eventName, accepte: false,
              // Le message de Meta dit pourquoi (token expiré, pixel inconnu…)
              erreur: parsed.error.message, code: parsed.error.code,
            }
          } else {
            console.log(`✅ Meta CAPI [${eventName}] envoyé — events_received: ${parsed.events_received}`)
            dernierEnvoi = {
              at: new Date().toISOString(), evenement: eventName, accepte: true,
              recus: parsed.events_received,
            }
          }
          resolve(parsed)
        } catch {
          dernierEnvoi = { at: new Date().toISOString(), evenement: eventName, accepte: false,
                           erreur: `Réponse illisible (HTTP ${res.statusCode})` }
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

module.exports = {
  sendMetaEvent, getDernierEnvoi,
  // Exposées pour pouvoir les vérifier sans rien envoyer à Meta
  normalizePhone, normalizeGeo, normalizeName,
}