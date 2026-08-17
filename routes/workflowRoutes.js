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

// Démarre (ou redémarre) le compte à rebours de l'atelier.
// Appelé quand une commande passe en « confirmé ».
const startCountdown = (order) => {
  const now = new Date()
  order.pipeline.confirmedAt = now
  order.pipeline.deadlineAt  = new Date(now.getTime() + Order.DEADLINE_DAYS * 24 * 60 * 60 * 1000)
}

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
    startCountdown(order)       // démarre le compte à rebours de 6 jours
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
// Le designer n'envoie AUCUN fichier : il transmet simplement la commande
// une fois son travail terminé. body: { notes } (optionnel)
router.post('/orders/:id/design', authorize('designer'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'design', req, res)) return

    order.pipeline.design = {
      files:       [],
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

// PATCH /orders/:id/designer-tag — étiquette posée par le designer
// (ex. « réponses lentes » pour un client peu réactif)
router.patch('/orders/:id/designer-tag', authorize('designer'), async (req, res) => {
  try {
    const { designerTag } = req.body
    if (!Order.DESIGNER_TAGS.includes(designerTag)) {
      return res.status(400).json({ message: 'Étiquette invalide' })
    }
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    order.pipeline.designerTag = designerTag
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

/* ══════════════════════════════════════════════════════════════
   ESPACE CONFIRMATRICE — gestion complète des commandes
   (liste filtrable, statut modifiable, urgence, édition, création)
══════════════════════════════════════════════════════════════ */

const Product = require('../models/Product')

// Statut public ⇄ étape du pipeline
const STATUS_TO_STAGE = {
  'en attente': 'confirmation',
  'confirmé':   'design',      // confirmé → part chez le designer
  'annulé':     'annulee',
}
const VALID_STATUSES = Object.keys(STATUS_TO_STAGE)

// GET /confirmation — liste des commandes gérées par la confirmatrice
//   ?status=en attente|confirmé|annulé   ?q=recherche   ?limit=
router.get('/confirmation', authorize('confirmatrice'), async (req, res) => {
  try {
    const { status, q } = req.query
    const limit = Math.min(parseInt(req.query.limit) || 100, 300)

    const filter = {}
    if (status && VALID_STATUSES.includes(status)) filter.status = status

    if (q && q.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [
        { 'customerInfo.firstName': rx },
        { 'customerInfo.lastName':  rx },
        { 'customerInfo.phone':     rx },
        { 'customerInfo.commune':   rx },
        { 'customerInfo.wilaya':    rx },
      ]
    }

    const orders = await Order.find(filter)
      .populate('items.product', 'name images')
      .sort({ createdAt: -1 })
      .limit(limit)

    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /confirmation/counts — compteurs par statut (onglets)
router.get('/confirmation/counts', authorize('confirmatrice'), async (req, res) => {
  try {
    const agg = await Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    const counts = { 'en attente': 0, 'confirmé': 0, 'annulé': 0, total: 0 }
    agg.forEach(r => {
      if (r._id in counts) counts[r._id] = r.count
      counts.total += r.count
    })
    res.json(counts)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /orders/:id/status — changer le statut (réversible)
router.patch('/orders/:id/status', authorize('confirmatrice'), async (req, res) => {
  try {
    const { status } = req.body
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Statut invalide' })
    }

    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    const nextStage = STATUS_TO_STAGE[status]

    // Sécurité : ne pas ramener en arrière une commande déjà travaillée
    // (design terminé, en production, emballée…) — sauf superadmin.
    const workedStages = ['production', 'emballage', 'livraison', 'termine']
    if (workedStages.includes(order.pipeline.stage) && !isSuperadmin(req.user?.role)) {
      return res.status(409).json({
        message: `Commande déjà à l'étape « ${order.pipeline.stage} », statut non modifiable.`,
      })
    }

    const wasConfirmed = order.status === 'confirmé'

    order.status = status
    order.pipeline.stage = nextStage

    // Passage en « confirmé » → démarre le compte à rebours de 6 jours
    if (status === 'confirmé') {
      order.pipeline.confirmedBy = req.user?.username || ''
      if (!wasConfirmed) startCountdown(order)
    }

    pushHistory(order, nextStage, req, `Statut → ${status}`)
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /orders/:id/urgency — étiquette d'urgence
router.patch('/orders/:id/urgency', authorize('confirmatrice'), async (req, res) => {
  try {
    const { urgency } = req.body
    if (!Order.URGENCY_LEVELS.includes(urgency)) {
      return res.status(400).json({ message: 'Niveau d\'urgence invalide' })
    }
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    order.pipeline.urgency = urgency
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// Recalcule le total d'après les articles (source de vérité : le prix envoyé)
const computeTotal = (items, deliveryFee = 0) =>
  items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0)
  + (Number(deliveryFee) || 0)

// Valide et normalise les articles reçus du client
async function normalizeItems(rawItems) {
  const items = []
  for (const it of rawItems || []) {
    const quantity = Number(it.quantity)
    if (!quantity || quantity <= 0) continue

    let name  = (it.name || '').trim()
    let price = Number(it.price) || 0

    // Si un produit du catalogue est référencé, on reprend son nom / son prix
    if (it.product) {
      const p = await Product.findById(it.product).select('name sizes')
      if (p) {
        name = name || p.name
        const sizeData = p.sizes.find(s => String(s.size) === String(it.size))
        if (sizeData && !it.price) price = sizeData.price
      }
    }
    if (!name) continue

    items.push({
      product:        it.product || undefined,
      name,
      size:           it.size || '',
      quantity,
      price,
      doubleSided:    !!it.doubleSided,
      selectedColors: Array.isArray(it.selectedColors) ? it.selectedColors : [],
      numberOfColors: it.numberOfColors != null ? Number(it.numberOfColors) : null,
    })
  }
  return items
}

// PUT /orders/:id — modifier une commande (client + articles + total)
router.put('/orders/:id', authorize('confirmatrice'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    const workedStages = ['production', 'emballage', 'livraison', 'termine']
    if (workedStages.includes(order.pipeline.stage) && !isSuperadmin(req.user?.role)) {
      return res.status(409).json({
        message: `Commande déjà à l'étape « ${order.pipeline.stage} », modification impossible.`,
      })
    }

    const { customerInfo, items, total } = req.body

    if (customerInfo) {
      const allowed = ['firstName', 'lastName', 'phone', 'wilaya', 'wilayaCode',
                       'commune', 'description', 'deliveryMethod', 'deliveryFee']
      allowed.forEach(k => {
        if (customerInfo[k] !== undefined) order.customerInfo[k] = customerInfo[k]
      })
    }

    if (items !== undefined) {
      const normalized = await normalizeItems(items)
      if (normalized.length === 0) {
        return res.status(400).json({ message: 'La commande doit contenir au moins un article' })
      }
      order.items = normalized
      order.total = total != null ? Number(total)
        : computeTotal(normalized, order.customerInfo?.deliveryFee)
    } else if (total != null) {
      order.total = Number(total)
    }

    pushHistory(order, order.pipeline.stage, req, 'Commande modifiée')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /confirmation — créer une commande manuellement
// (aucun événement Meta n'est envoyé : ce n'est pas une vente issue d'une pub)
router.post('/confirmation', authorize('confirmatrice'), async (req, res) => {
  try {
    const { customerInfo, items, total, status, urgency } = req.body

    if (!customerInfo?.firstName || !customerInfo?.lastName || !customerInfo?.phone) {
      return res.status(400).json({ message: 'Nom, prénom et téléphone sont requis' })
    }
    if (!customerInfo?.wilaya || !customerInfo?.commune) {
      return res.status(400).json({ message: 'Wilaya et commune sont requises' })
    }

    const normalized = await normalizeItems(items)
    if (normalized.length === 0) {
      return res.status(400).json({ message: 'Ajoutez au moins un article' })
    }

    const finalStatus = VALID_STATUSES.includes(status) ? status : 'en attente'
    const order = new Order({
      customerInfo: {
        firstName:      customerInfo.firstName.trim(),
        lastName:       customerInfo.lastName.trim(),
        phone:          String(customerInfo.phone).trim(),
        wilaya:         customerInfo.wilaya,
        wilayaCode:     customerInfo.wilayaCode != null ? Number(customerInfo.wilayaCode) : null,
        commune:        customerInfo.commune,
        description:    customerInfo.description || '',
        logoUrls:       Array.isArray(customerInfo.logoUrls) ? customerInfo.logoUrls : [],
        deliveryMethod: customerInfo.deliveryMethod || 'Domicile',
        deliveryFee:    customerInfo.deliveryFee != null ? Number(customerInfo.deliveryFee) : null,
      },
      items:  normalized,
      total:  total != null ? Number(total) : computeTotal(normalized, customerInfo.deliveryFee),
      status: finalStatus,
    })

    order.pipeline.stage   = STATUS_TO_STAGE[finalStatus]
    order.pipeline.manual  = true
    if (Order.URGENCY_LEVELS.includes(urgency)) order.pipeline.urgency = urgency
    if (finalStatus === 'confirmé') {
      order.pipeline.confirmedBy = req.user?.username || ''
      startCountdown(order)
    }

    pushHistory(order, order.pipeline.stage, req, 'Commande créée manuellement')
    await order.save()

    res.status(201).json(order)
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
