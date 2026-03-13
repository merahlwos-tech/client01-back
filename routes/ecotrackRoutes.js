const express = require('express')
const router  = express.Router()

const ECOTRACK_BASE  = process.env.ECOTRACK_BASE_URL  || 'https://ecotrack.dz'
const ECOTRACK_TOKEN = process.env.ECOTRACK_API_TOKEN || ''

// Authorization: Bearer <token>
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

// GET /api/ecotrack/wilayas
// Réponse API : [{wilaya_id, wilaya_name}, ...]  → tableau direct
router.get('/wilayas', async (req, res) => {
  try {
    const cached = getCached('wilayas')
    if (cached) return res.json(cached)

    const resp = await fetch(`${ECOTRACK_BASE}/api/v1/get/wilayas`, { headers: ecoHeaders() })
    if (!resp.ok) throw new Error(`ECOTRACK wilayas: ${resp.status}`)

    const data = await resp.json()
    // L'API retourne directement un tableau
    const list = Array.isArray(data) ? data : []

    cache.set('wilayas', { data: list, ts: Date.now() })
    res.json(list)
  } catch (err) {
    console.error('[ECOTRACK] wilayas error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK wilayas', error: err.message })
  }
})

// GET /api/ecotrack/communes?wilaya_id=16
// Réponse API : {"0": {nom, wilaya_id, code_postal, has_stop_desk}, "1": {...}, ...}
// → objet avec clés numériques, PAS un tableau → Object.values()
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
    // L'API retourne un objet {"0":{...},"1":{...}} → on le convertit en tableau
    const list = Array.isArray(data) ? data : Object.values(data)

    cache.set(cacheKey, { data: list, ts: Date.now() })
    res.json(list)
  } catch (err) {
    console.error('[ECOTRACK] communes error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK communes', error: err.message })
  }
})

// GET /api/ecotrack/fees
// Réponse API : { livraison: [{wilaya_id, tarif, tarif_stopdesk},...], pickup:[...], ... }
// → on expose uniquement livraison (tarifs de livraison)
router.get('/fees', async (req, res) => {
  try {
    const cached = getCached('fees')
    if (cached) return res.json(cached)

    const resp = await fetch(`${ECOTRACK_BASE}/api/v1/get/fees`, { headers: ecoHeaders() })
    if (!resp.ok) throw new Error(`ECOTRACK fees: ${resp.status}`)

    const data = await resp.json()
    // Les tarifs de livraison sont sous data.livraison
    const list = Array.isArray(data) ? data : (data?.livraison || [])

    cache.set('fees', { data: list, ts: Date.now() })
    res.json(list)
  } catch (err) {
    console.error('[ECOTRACK] fees error:', err.message)
    res.status(502).json({ message: 'Erreur ECOTRACK fees', error: err.message })
  }
})

module.exports = router