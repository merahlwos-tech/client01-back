const express  = require('express')
const router   = express.Router()
const Settings = require('../models/Settings')

/* ─────────────────────────────────────────────────────────────
   GET /api/settings/hidden-categories  — route PUBLIQUE
   Retourne la liste des catégories cachées sans authentification
   (utilisé par le frontend pour masquer les cartes / liens nav)
   ─────────────────────────────────────────────────────────── */
router.get('/hidden-categories', async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'hiddenCategories' }).lean()
    res.json(setting?.value || [])
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

module.exports = router
