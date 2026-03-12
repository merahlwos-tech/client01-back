const express = require('express')
const router  = express.Router()

const ECOTRACK_BASE = process.env.ECOTRACK_BASE_URL || 'https://ecotrack.dz'
const ECOTRACK_TOKEN = process.env.ECOTRACK_API_TOKEN || ''

const ecoHeaders = () => ({
  'Content-Type': 'application/json',
  ...(ECOTRACK_TOKEN ? { Authorization: `Bearer ${ECOTRACK_TOKEN}` } : {}),
})

// Petite mise en cache en mémoire (TTL 10 min) pour réduire les appels répétés
const cache = new Map()
function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > 10 * 60 * 1000) { cache.delete(key); return null }
  return entry.data
}

// GET /api/ecotrack/wilayas
router.get('/wilayas', async (req, res) => {
  try {
    const cached = getCached('wilayas')
    if (cached) return res.json(cached)

    const resp = await fetch(`${ECOTRACK_BASE}/api/v1/get/wilayas`, {
      headers: ecoHeaders(),
    })
    if (!resp.ok) throw new Error(`ECOTRACK wilayas: ${resp.status}`)
    const data = await resp.json()
    cache.set('wilayas', { data, ts: Date.now() })
    res.json(data)
  } catch (err) {
    console.error('[ECOTRACK] wilayas error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK wilayas', error: err.message })
  }
})

// GET /api/ecotrack/communes?wilaya_id=16
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
    cache.set(cacheKey, { data, ts: Date.now() })
    res.json(data)
  } catch (err) {
    console.error('[ECOTRACK] communes error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK communes', error: err.message })
  }
})

// GET /api/ecotrack/fees
router.get('/fees', async (req, res) => {
  try {
    const cached = getCached('fees')
    if (cached) return res.json(cached)

    const resp = await fetch(`${ECOTRACK_BASE}/api/v1/get/fees`, {
      headers: ecoHeaders(),
    })
    if (!resp.ok) throw new Error(`ECOTRACK fees: ${resp.status}`)
    const data = await resp.json()
    cache.set('fees', { data, ts: Date.now() })
    res.json(data)
  } catch (err) {
    console.error('[ECOTRACK] fees error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK fees', error: err.message })
  }
})

module.exports = router