// routes/workflowRoutes.js — Pipeline atelier (confirmatrice → designer →
// production → emballage → livraison). Réutilise la collection Order existante.
const express       = require('express')
const router        = express.Router()
const Order         = require('../models/Order')
const RawMaterial   = require('../models/RawMaterial')
const StockMovement = require('../models/StockMovement')
const { sendToEcotrack } = require('../utils/ecotrack')
const { authenticateUser, authorize, isSuperadmin } = require('../middleware/auth')

router.use(authenticateUser)

// Qui AGIT sur chaque étape (peut la faire avancer)
const STAGE_ACTOR = {
  confirmation: 'confirmatrice',
  design:       'designer',
  production:   'production',
  emballage:    'emballage',
  livraison:    'chef_production',
}

// Le chef de production et le superadmin voient toutes les étapes (supervision).
// Un acteur ne voit que son étape.
const canView = (role, stage) =>
  isSuperadmin(role) || role === 'chef_production' || role === STAGE_ACTOR[stage]

// Ajoute une entrée d'historique
const pushHistory = (order, stage, req, note = '') => {
  order.pipeline.history.push({
    stage, by: req.user?.username || '', role: req.user?.role || '', note, at: new Date(),
  })
}

// Garde de transition : l'acteur doit correspondre à l'étape courante
// (le superadmin peut agir quelle que soit l'étape).
const guardStage = (order, expectedStage, req, res) => {
  if (isSuperadmin(req.user?.role)) return true
  if (order.pipeline.stage !== expectedStage) {
    res.status(409).json({ message: `Commande déjà à l'étape « ${order.pipeline.stage} »` })
    return false
  }
  return true
}

/* ══════════════════════════════════════════════════════════════
   LECTURE
══════════════════════════════════════════════════════════════ */

// GET /api/workflow/stats — nombre de commandes par étape (dashboards)
router.get('/stats', async (req, res) => {
  try {
    const agg = await Order.aggregate([
      { $group: { _id: '$pipeline.stage', count: { $sum: 1 } } },
    ])
    const byStage = { confirmation: 0, design: 0, production: 0, emballage: 0, livraison: 0, termine: 0, annulee: 0 }
    agg.forEach(r => { if (r._id) byStage[r._id] = r.count })
    res.json(byStage)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/workflow/orders?stage=confirmation — commandes d'une étape
router.get('/orders', async (req, res) => {
  try {
    const stage = req.query.stage
    if (!stage || !STAGE_ACTOR[stage] && !['termine', 'annulee'].includes(stage)) {
      return res.status(400).json({ message: 'Étape invalide' })
    }
    if (!canView(req.user?.role, stage)) {
      return res.status(403).json({ message: 'Accès refusé à cette étape' })
    }
    const orders = await Order.find({ 'pipeline.stage': stage })
      .populate('items.product', 'name images')
      .sort({ createdAt: 1 })   // FIFO : les plus anciennes d'abord
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/workflow/orders/:id — détail d'une commande
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('items.product', 'name images')
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!canView(req.user?.role, order.pipeline.stage)) {
      return res.status(403).json({ message: 'Accès refusé' })
    }
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

/* ══════════════════════════════════════════════════════════════
   TRANSITIONS
══════════════════════════════════════════════════════════════ */

// POST /orders/:id/confirm — confirmatrice : confirmation → design
router.post('/orders/:id/confirm', authorize('confirmatrice'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'confirmation', req, res)) return

    order.pipeline.stage       = 'design'
    order.pipeline.confirmedBy = req.user?.username || ''
    order.status = 'confirmé'   // cohérence avec le statut public (sans envoi Ecotrack)
    pushHistory(order, 'design', req, 'Commande confirmée → design')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /orders/:id/cancel — confirmatrice/superadmin : → annulee
router.post('/orders/:id/cancel', authorize('confirmatrice'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    order.pipeline.stage = 'annulee'
    order.status = 'annulé'
    pushHistory(order, 'annulee', req, req.body.reason || 'Commande annulée')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /orders/:id/design — designer : design → production
// body: { files: [url], notes }
router.post('/orders/:id/design', authorize('designer'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'design', req, res)) return

    const files = Array.isArray(req.body.files) ? req.body.files.filter(Boolean) : []
    if (files.length === 0) {
      return res.status(400).json({ message: 'Ajoutez au moins un fichier de design' })
    }

    order.pipeline.design = {
      files,
      notes:       req.body.notes || '',
      submittedAt: new Date(),
      by:          req.user?.username || '',
    }
    order.pipeline.stage = 'production'
    pushHistory(order, 'production', req, 'Design terminé → production')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /orders/:id/produce — production : production → emballage
// body: { materialsUsed: [{ material, quantity }], notes }
// Décrémente le stock et journalise la consommation.
router.post('/orders/:id/produce', authorize('production'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'production', req, res)) return

    const raw = Array.isArray(req.body.materialsUsed) ? req.body.materialsUsed : []
    const used = raw
      .map(m => ({ material: m.material, quantity: Number(m.quantity) }))
      .filter(m => m.material && m.quantity > 0)

    // Applique la consommation au stock + journalise
    const applied = []
    for (const u of used) {
      const material = await RawMaterial.findById(u.material)
      if (!material) continue
      material.quantity = Math.max(0, material.quantity - u.quantity)
      await material.save()
      await StockMovement.create({
        material: material._id, materialName: material.name,
        type: 'out', quantity: u.quantity, order: order._id,
        by: req.user?.username || '', note: 'Consommation production',
      })
      applied.push({ material: material._id, name: material.name, quantity: u.quantity })
    }

    order.pipeline.materialsUsed   = applied
    order.pipeline.productionNotes = req.body.notes || ''
    order.pipeline.stage = 'emballage'
    pushHistory(order, 'emballage', req, `Fabrication terminée (${applied.length} matière(s) consommée(s)) → emballage`)
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /orders/:id/package — emballage : emballage → livraison
router.post('/orders/:id/package', authorize('emballage'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'emballage', req, res)) return

    order.pipeline.packagingNotes = req.body.notes || ''
    order.pipeline.stage = 'livraison'
    pushHistory(order, 'livraison', req, 'Emballage terminé → livraison')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /orders/:id/deliver — chef de production : livraison → termine
// Envoie la commande à Ecotrack (compagnie de livraison).
//   body.skipEcotrack : marque livrée SANS envoi (livraison manuelle)
//   body.force        : passe en terminé même si l'envoi Ecotrack a échoué
// En cas d'échec d'envoi (sans force), la commande RESTE en livraison pour retry.
router.post('/orders/:id/deliver', authorize('chef_production'), async (req, res) => {
  try {
    const { skipEcotrack, force } = req.body
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'livraison', req, res)) return

    let ecotrackResult = null
    if (!skipEcotrack) {
      try {
        ecotrackResult = await sendToEcotrack(order)
      } catch (err) {
        console.error('[ECOTRACK] Erreur envoi (chef):', err.message)
        ecotrackResult = { error: err.message }
      }
      // Échec d'envoi et pas de forçage → on ne fait pas avancer la commande
      if (ecotrackResult?.error && !force) {
        await order.save()   // sauvegarde un éventuel état partiel
        return res.status(502).json({
          message: `Échec de l'envoi à la livraison : ${ecotrackResult.error}`,
          _ecotrackResult: ecotrackResult,
        })
      }
    }

    order.pipeline.stage = 'termine'
    pushHistory(order, 'termine', req,
      ecotrackResult?.tracking ? `Expédiée (tracking ${ecotrackResult.tracking})`
        : skipEcotrack ? 'Marquée livrée (sans envoi)' : 'Marquée livrée')
    await order.save()
    res.json({ ...order.toObject(), _ecotrackResult: ecotrackResult })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /orders/:id/stage — superadmin : forcer une étape (override)
router.patch('/orders/:id/stage', authorize('superadmin'), async (req, res) => {
  try {
    const { stage, note } = req.body
    if (!Order.PIPELINE_STAGES.includes(stage)) {
      return res.status(400).json({ message: 'Étape invalide' })
    }
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    order.pipeline.stage = stage
    pushHistory(order, stage, req, note || 'Étape modifiée par le superadmin')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

module.exports = router
