/**
 * metaRoutes.js — Endpoint CAPI pour les événements frontend
 *
 * Route : POST /api/meta/event
 *
 * Reçoit les événements PageView, ViewContent, AddToCart, InitiateCheckout,
 * Lead, AddPaymentInfo depuis le frontend et les relaie à Meta CAPI avec :
 *   - l'IP réelle du visiteur (depuis les headers serveur)
 *   - le User-Agent navigateur
 *   - les cookies fbp / fbc (matching cross-device)
 *   - les données e-commerce
 *
 * Note : Purchase est géré directement dans orderRoutes.js
 * pour avoir accès aux données utilisateur complètes (phone, nom…).
 *
 * CHANGELOG :
 *  ✅ NEW — Extraction et transmission des cookies fbp / fbc
 *  ✅ NEW — Événements Lead et AddPaymentInfo ajoutés à la liste autorisée
 *  ✅ FIX — Transmission du tableau contents à sendMetaEvent
 */

const express        = require('express')
const router         = express.Router()
const { sendMetaEvent } = require('../utils/metaCAPI')

// Événements autorisés (Purchase géré par orderRoutes)
const ALLOWED_EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Lead', 'AddPaymentInfo']

/**
 * POST /api/meta/event
 * Body : {
 *   event_name, event_id, event_source_url,
 *   user_agent, fbp, fbc,
 *   content_ids, content_name, content_type,
 *   value, currency, num_items, contents
 * }
 */
router.post('/event', async (req, res) => {
  // Réponse immédiate — le tracking ne doit jamais ralentir le client
  res.json({ ok: true })

  try {
    const {
      event_name,
      event_id,
      event_source_url,
      user_agent,
      fbp,
      fbc,
      content_ids,
      content_name,
      content_type,
      value,
      currency,
      num_items,
      contents,
    } = req.body

    // Validation de base
    if (!event_name || !ALLOWED_EVENTS.includes(event_name)) return
    if (!event_id) return

    // IP réelle du visiteur (derrière un proxy / Nginx)
    const ip = (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.socket?.remoteAddress ||
      ''
    ).replace('::ffff:', '') // Normalise IPv6-mapped IPv4

    await sendMetaEvent(event_name, {
      eventId:   event_id,
      sourceUrl: event_source_url,
      userData: {
        ip,
        userAgent: user_agent || req.headers['user-agent'],
        // Cookies Meta pour le matching cross-device
        ...(fbp && { fbp }),
        ...(fbc && { fbc }),
      },
      customData: {
        ...(content_ids   && { content_ids }),
        ...(content_name  && { content_name }),
        ...(content_type  && { content_type }),
        ...(value   != null && { value }),
        ...(currency       && { currency }),
        ...(num_items != null && { num_items }),
        ...(contents       && { contents }),
      },
    })
  } catch (err) {
    console.error('Meta CAPI route error:', err.message)
  }
})

module.exports = router