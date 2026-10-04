const express = require('express')
const router  = express.Router()
const { authenticateAdmin } = require('../middleware/auth')

const ECOTRACK_BASE  = process.env.ECOTRACK_BASE_URL  || 'https://ecotrack.dz'
const ECOTRACK_TOKEN = process.env.ECOTRACK_API_TOKEN || ''

const ecoHeaders = () => ({
  'Content-Type': 'application/json',
  ...(ECOTRACK_TOKEN ? { Authorization: `Bearer ${ECOTRACK_TOKEN}` } : {}),
})

// Cache mémoire 10 min
const cache = new Map()
function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > 10 * 60 * 1000) { cache.delete(key); return null }
  return entry.data
}

// ─── GET /api/ecotrack/wilayas ───────────────────────────────────────────────
router.get('/wilayas', async (req, res) => {
  try {
    const cached = getCached('wilayas')
    if (cached) return res.json(cached)
    const resp = await fetch(`${ECOTRACK_BASE}/api/v1/get/wilayas`, { headers: ecoHeaders() })
    if (!resp.ok) throw new Error(`ECOTRACK wilayas: ${resp.status}`)
    const data = await resp.json()
    const list = Array.isArray(data) ? data : []
    cache.set('wilayas', { data: list, ts: Date.now() })
    res.json(list)
  } catch (err) {
    console.error('[ECOTRACK] wilayas error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK wilayas', error: err.message })
  }
})

// ─── GET /api/ecotrack/communes?wilaya_id=16 ────────────────────────────────
router.get('/communes', async (req, res) => {
  try {
    const { wilaya_id } = req.query
    const cacheKey = `communes_${wilaya_id || 'all'}`
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)
    const url = wilaya_id
      ? `${ECOTRACK_BASE}/api/v1/get/communes?wilaya_id=${wilaya_id}`
      : `${ECOTRACK_BASE}/api/v1/get/communes`
    const resp = await fetch(url, { headers: ecoHeaders() })
    if (!resp.ok) throw new Error(`ECOTRACK communes: ${resp.status}`)
    const data = await resp.json()
    const list = Array.isArray(data) ? data : Object.values(data)
    cache.set(cacheKey, { data: list, ts: Date.now() })
    res.json(list)
  } catch (err) {
    console.error('[ECOTRACK] communes error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK communes', error: err.message })
  }
})

// ─── GET /api/ecotrack/fees ──────────────────────────────────────────────────
router.get('/fees', async (req, res) => {
  try {
    const cached = getCached('fees')
    if (cached) return res.json(cached)
    const resp = await fetch(`${ECOTRACK_BASE}/api/v1/get/fees`, { headers: ecoHeaders() })
    if (!resp.ok) throw new Error(`ECOTRACK fees: ${resp.status}`)
    const data = await resp.json()
    const list = Array.isArray(data) ? data : (data?.livraison || [])
    cache.set('fees', { data: list, ts: Date.now() })
    res.json(list)
  } catch (err) {
    console.error('[ECOTRACK] fees error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK fees', error: err.message })
  }
})

// ─── POST /api/ecotrack/send-order/:id ───────────────────────────────────────
// Envoie la commande à Ecotrack et sauvegarde le tracking
router.post('/send-order/:id', authenticateAdmin, async (req, res) => {
  try {
    const Order = require('../models/Order')
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    // Déjà envoyée ?
    if (order.ecotrackTracking) {
      return res.json({
        success: true,
        tracking: order.ecotrackTracking,
        alreadySent: true,
        message: 'Commande déjà envoyée à Ecotrack',
      })
    }

    const { customerInfo, total, items } = order
    const wilayaCode = customerInfo.wilayaCode

    if (!wilayaCode) {
      return res.status(400).json({
        message: 'Code wilaya manquant — commande passée avant la mise à jour.',
      })
    }

    // Construction du nom du produit pour Ecotrack
    const produitLabel = items.map(i => `${i.name} x${i.quantity}`).join(', ').slice(0, 255)

    const params = new URLSearchParams({
      reference:   order._id.toString().slice(-8).toUpperCase(),
      nom_client:  `${customerInfo.firstName} ${customerInfo.lastName}`,
      telephone:   customerInfo.phone.replace(/\s/g, ''),
      adresse:     customerInfo.commune,
      commune:     customerInfo.commune,
      code_wilaya: String(wilayaCode),
      montant:     String(total),
      type:        '1',  // Livraison
      stop_desk:   customerInfo.deliveryMethod === 'Stop Desk' ? '1' : '0',
      produit:     produitLabel,
    })

    const url = `${ECOTRACK_BASE}/api/v1/create/order?${params.toString()}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: ecoHeaders(),
    })

    const data = await resp.json()

    if (!data.success) {
      console.error('[ECOTRACK] send-order error:', data)
      return res.status(400).json({
        message: data.message || 'Erreur Ecotrack',
        errors: data.errors || null,
      })
    }

    // Sauvegarde du tracking
    order.ecotrackTracking = data.tracking
    order.ecotrackSentAt   = new Date()
    await order.save()

    res.json({ success: true, tracking: data.tracking })

  } catch (err) {
    console.error('[ECOTRACK] send-order error:', err.message)
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// ─── GET /api/ecotrack/label/:tracking ───────────────────────────────────────
// Proxy pour télécharger l'étiquette PDF depuis Ecotrack
router.get('/label/:tracking', authenticateAdmin, async (req, res) => {
  try {
    const { tracking } = req.params
    const url = `${ECOTRACK_BASE}/api/v1/get/order/label?tracking=${encodeURIComponent(tracking)}`

    const resp = await fetch(url, { headers: ecoHeaders() })

    if (!resp.ok) {
      return res.status(resp.status).json({ message: `Ecotrack label: ${resp.status}` })
    }

    // Retransmission du PDF
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="etiquette-${tracking}.pdf"`)

    const buffer = await resp.arrayBuffer()
    res.send(Buffer.from(buffer))

  } catch (err) {
    console.error('[ECOTRACK] label error:', err.message)
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

module.exports = router