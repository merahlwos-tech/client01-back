// routes/workflowRoutes.js — Pipeline atelier (confirmatrice → designer →
// production → emballage → livraison). Réutilise la collection Order existante.
const express       = require('express')
const router        = express.Router()
const Order         = require('../models/Order')
const RawMaterial   = require('../models/RawMaterial')
const StockMovement = require('../models/StockMovement')
const { sendToEcotrack } = require('../utils/ecotrack')
const { authenticateUser, authorize, isSuperadmin } = require('../middleware/auth')

// Un vrai superadmin peut passer outre les garde-fous metier (sauter une
// etape, modifier une commande deja fabriquee). Le visiteur de l'acces libre,
// lui, obtient l'acces aux pages mais PAS ce droit d'override.
const canOverride = (req) => isSuperadmin(req.user?.role) && !req.user?.openAccess

// Prérogatives du chef de production : forcer une étape, modifier une commande
// déjà en fabrication. En accès libre, les rôles n'existent plus (tout le monde
// passe pour un superadmin) : le client doit alors marquer explicitement son
// intention avec `asChef: true`, ce qui évite les manipulations accidentelles
// sans prétendre à une sécurité que l'accès libre ne permet pas.
const canForce = (req) =>
  canOverride(req) ||
  req.user?.role === 'chef_production' ||
  (req.user?.openAccess && req.body?.asChef === true)


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
// Un acteur ne voit que son étape — sauf le designer, qui doit pouvoir suivre
// les commandes qu'il a envoyées en production (section « Envoyé à la
// production », tant qu'elles ne sont pas fabriquées).
const canView = (role, stage) =>
  isSuperadmin(role) ||
  role === 'chef_production' ||
  role === STAGE_ACTOR[stage] ||
  (role === 'designer' && stage === 'production')

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
  if (canOverride(req)) return true
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

// Priorité d'affichage : les plus urgentes d'abord
const URGENCY_RANK = { tres_urgent: 0, urgent: 1, normal: 2 }

// Tri : urgence ↓, puis échéance la plus proche, puis FIFO
function sortByPriority(orders) {
  return orders.sort((a, b) => {
    const ra = URGENCY_RANK[a.pipeline?.urgency] ?? 2
    const rb = URGENCY_RANK[b.pipeline?.urgency] ?? 2
    if (ra !== rb) return ra - rb

    const da = a.pipeline?.deadlineAt ? new Date(a.pipeline.deadlineAt).getTime() : Infinity
    const db = b.pipeline?.deadlineAt ? new Date(b.pipeline.deadlineAt).getTime() : Infinity
    if (da !== db) return da - db

    return new Date(a.createdAt) - new Date(b.createdAt)   // FIFO
  })
}

// GET /api/workflow/orders?stage=confirmation — commandes d'une étape
//   &slow=1 → uniquement les clients signalés « réponses lentes »
//   &slow=0 (défaut) → tout sauf ces clients
router.get('/orders', async (req, res) => {
  try {
    const stage = req.query.stage
    if (!stage || !STAGE_ACTOR[stage] && !['termine', 'annulee'].includes(stage)) {
      return res.status(400).json({ message: 'Étape invalide' })
    }
    if (!canView(req.user?.role, stage)) {
      return res.status(403).json({ message: 'Accès refusé à cette étape' })
    }

    const filter = { 'pipeline.stage': stage }

    // Les commandes marquées « réponses lentes » sont mises de côté :
    // elles n'apparaissent que dans la liste dédiée. ($ne couvre aussi
    // les commandes antérieures, où le champ n'existe pas.)
    if (req.query.slow === '1') {
      filter['pipeline.designerTag'] = 'reponses_lentes'
    } else {
      filter['pipeline.designerTag'] = { $ne: 'reponses_lentes' }
    }

    // Planification (la production ne voit que le jour même).
    //   &date=YYYY-MM-DD  → à fabriquer ce jour-là
    //   &overdueBefore=YYYY-MM-DD → planifiées avant cette date, non traitées
    const { date, overdueBefore } = req.query
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      filter['pipeline.productionDate'] = date
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(overdueBefore || ''))) {
      filter['pipeline.productionDate'] = { $lt: overdueBefore, $ne: '' }
    }

    const orders = await Order.find(filter)
      .populate('items.product', 'name images')
      .populate('pipeline.customTags')
      .lean()

    res.json(sortByPriority(orders))
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/workflow/orders/slow-count?stage=design — nb de clients lents
router.get('/orders/slow-count', async (req, res) => {
  try {
    const stage = req.query.stage || 'design'
    const count = await Order.countDocuments({
      'pipeline.stage': stage,
      'pipeline.designerTag': 'reponses_lentes',
    })
    res.json({ count })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/workflow/products — catalogue COMPLET pour la saisie de commande.
// La route publique /api/products masque les catégories cachées aux visiteurs ;
// l'atelier, lui, doit pouvoir vendre l'ensemble du catalogue.
router.get('/products', async (req, res) => {
  try {
    const Product = require('../models/Product')
    const products = await Product.find()
      .sort({ position: 1, createdAt: 1 })
      .lean()
    res.json(products)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/workflow/production-planning?from=YYYY-MM-DD&to=YYYY-MM-DD
// Nombre de commandes à fabriquer par jour, pour l'emploi du temps hebdomadaire.
router.get('/production-planning', async (req, res) => {
  try {
    const { from, to } = req.query
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))
    if (!ok(from) || !ok(to)) {
      return res.status(400).json({ message: 'Intervalle de dates invalide' })
    }

    // productionDate est une chaîne « YYYY-MM-DD » : la comparaison
    // lexicographique équivaut à une comparaison chronologique.
    const agg = await Order.aggregate([
      {
        $match: {
          'pipeline.stage': 'production',
          'pipeline.productionDate': { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id:    '$pipeline.productionDate',
          total:  { $sum: 1 },
          urgent: { $sum: { $cond: [{ $in: ['$pipeline.urgency', ['urgent', 'tres_urgent']] }, 1, 0] } },
          pieces: { $sum: { $sum: '$items.quantity' } },
        },
      },
      { $sort: { _id: 1 } },
    ])

    res.json(agg.map(d => ({
      date: d._id, total: d.total, urgent: d.urgent, pieces: d.pieces,
    })))
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/workflow/orders/counters?date=YYYY-MM-DD
// Compteurs des onglets du designer et de la production
router.get('/orders/counters', async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? req.query.date : null

    const notSlow = { $ne: 'reponses_lentes' }

    const [aTraiter, validees, enProduction, slow, duJour, enRetard] = await Promise.all([
      // chez le designer, pas encore validées
      Order.countDocuments({ 'pipeline.stage': 'design', 'pipeline.designValidated': { $ne: true }, 'pipeline.designerTag': notSlow }),
      // validées mais pas encore envoyées
      Order.countDocuments({ 'pipeline.stage': 'design', 'pipeline.designValidated': true, 'pipeline.designerTag': notSlow }),
      // envoyées en production, pas encore traitées
      Order.countDocuments({ 'pipeline.stage': 'production' }),
      Order.countDocuments({ 'pipeline.stage': 'design', 'pipeline.designerTag': 'reponses_lentes' }),
      date ? Order.countDocuments({ 'pipeline.stage': 'production', 'pipeline.productionDate': date }) : 0,
      date ? Order.countDocuments({ 'pipeline.stage': 'production', 'pipeline.productionDate': { $lt: date, $ne: '' } }) : 0,
    ])

    res.json({ aTraiter, validees, enProduction, slow, duJour, enRetard })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/workflow/orders/:id — détail d'une commande
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('items.product', 'name images')
      .populate('pipeline.customTags')
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

// PATCH /orders/:id/design-validate — designer : marque son travail « validé »
// La commande RESTE chez le designer : elle ne part en production que via
// /send-production. body: { validated: true|false, notes }
router.patch('/orders/:id/design-validate', authorize('designer'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'design', req, res)) return

    const validated = req.body.validated !== false

    order.pipeline.designValidated   = validated
    order.pipeline.designValidatedAt = validated ? new Date() : null

    if (validated) {
      order.pipeline.design = {
        files:       [],
        notes:       req.body.notes ?? order.pipeline.design?.notes ?? '',
        submittedAt: new Date(),
        by:          req.user?.username || '',
      }
    }

    pushHistory(order, 'design', req, validated ? 'Design validé' : 'Validation retirée')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /orders/:id/send-production — designer : design → production
// body: { productionDate: 'YYYY-MM-DD', productionDay: 0-6, notes }
// La date est calculée côté client (fuseau de l'atelier) pour éviter tout
// décalage de jour avec le serveur.
router.post('/orders/:id/send-production', authorize('designer'), async (req, res) => {
  try {
    const { productionDate, productionDay, notes } = req.body

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(productionDate || ''))) {
      return res.status(400).json({ message: 'Jour de fabrication invalide' })
    }
    const day = Number(productionDay)
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return res.status(400).json({ message: 'Jour de la semaine invalide' })
    }

    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (!guardStage(order, 'design', req, res)) return

    if (!order.pipeline.designValidated && !canOverride(req)) {
      return res.status(409).json({ message: 'Validez d\'abord le design avant de l\'envoyer' })
    }

    if (notes !== undefined) order.pipeline.design.notes = notes

    order.pipeline.productionDate     = productionDate
    order.pipeline.productionDay      = day
    order.pipeline.sentToProductionAt = new Date()
    order.pipeline.stage              = 'production'

    pushHistory(order, 'production', req, `Envoyée en production pour le ${productionDate}`)
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /orders/:id/production-day — replanifier une commande déjà envoyée
// (tant que la production ne l'a pas traitée).
// Le chef de production peut corriger l'affectation faite par le designer.
router.patch('/orders/:id/production-day', authorize('designer', 'chef_production'), async (req, res) => {
  try {
    const { productionDate, productionDay } = req.body
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(productionDate || ''))) {
      return res.status(400).json({ message: 'Jour de fabrication invalide' })
    }
    const day = Number(productionDay)
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return res.status(400).json({ message: 'Jour de la semaine invalide' })
    }

    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    if (order.pipeline.stage !== 'production' && !canOverride(req)) {
      return res.status(409).json({ message: 'Commande déjà traitée par la production' })
    }

    order.pipeline.productionDate = productionDate
    order.pipeline.productionDay  = day
    pushHistory(order, 'production', req, `Replanifiée au ${productionDate}`)
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /orders/:id/pull-back — retirer une commande de la production
// (« ne pas donner à la production ») tant qu'elle n'est pas traitée.
// Accessible au designer et au chef de production.
router.post('/orders/:id/pull-back', authorize('designer', 'chef_production'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    if (order.pipeline.stage !== 'production' && !canOverride(req)) {
      return res.status(409).json({
        message: 'Commande déjà traitée par la production — retrait impossible',
      })
    }

    order.pipeline.stage              = 'design'
    order.pipeline.productionDate     = ''
    order.pipeline.productionDay      = null
    order.pipeline.sentToProductionAt = null

    pushHistory(order, 'design', req, 'Retirée de la production par le designer')
    await order.save()
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

/* ══════════════════════════════════════════════════════════════
   NOTES PARTAGÉES — n'importe quel service peut en ajouter,
   tout le monde les voit sur la commande.
══════════════════════════════════════════════════════════════ */

// POST /orders/:id/notes — ajouter une note { text }
router.post('/orders/:id/notes', async (req, res) => {
  try {
    const text = String(req.body.text || '').trim()
    if (!text) return res.status(400).json({ message: 'Note vide' })

    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    order.pipeline.notes.push({
      text: text.slice(0, 500),
      by:   req.user?.username || '',
      role: req.user?.role || '',
      at:   new Date(),
    })
    await order.save()
    await order.populate('pipeline.customTags')
    res.status(201).json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// DELETE /orders/:id/notes/:noteId — retirer une note (auteur ou superadmin)
router.delete('/orders/:id/notes/:noteId', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    const note = order.pipeline.notes.id(req.params.noteId)
    if (!note) return res.status(404).json({ message: 'Note introuvable' })

    const isAuthor = note.by && note.by === req.user?.username
    if (!isAuthor && !canOverride(req)) {
      return res.status(403).json({ message: 'Seul l\'auteur peut supprimer sa note' })
    }

    note.deleteOne()
    await order.save()
    await order.populate('pipeline.customTags')
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

/* ══════════════════════════════════════════════════════════════
   SERVICE INSOLATION
   Voit les commandes validées par le designer et les marque
   « confirmé » une fois l'insolation faite.
══════════════════════════════════════════════════════════════ */

// GET /insolation?status=en_attente|confirme
router.get('/insolation', authorize('insolation'), async (req, res) => {
  try {
    const status = Order.INSOLATION_STATUS.includes(req.query.status)
      ? req.query.status : 'en_attente'

    const filter = {
      'pipeline.designValidated': true,                    // validées par le designer
      'pipeline.stage': { $nin: ['annulee', 'termine'] },   // encore dans le circuit
    }
    // en_attente couvre aussi les commandes antérieures (champ absent)
    filter['pipeline.insolation.status'] = status === 'confirme'
      ? 'confirme'
      : { $ne: 'confirme' }

    const orders = await Order.find(filter)
      .populate('items.product', 'name images')
      .populate('pipeline.customTags')
      .lean()

    res.json(sortByPriority(orders))
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /insolation/counts — compteurs des deux listes
router.get('/insolation/counts', authorize('insolation'), async (req, res) => {
  try {
    const base = {
      'pipeline.designValidated': true,
      'pipeline.stage': { $nin: ['annulee', 'termine'] },
    }
    const [enAttente, confirme] = await Promise.all([
      Order.countDocuments({ ...base, 'pipeline.insolation.status': { $ne: 'confirme' } }),
      Order.countDocuments({ ...base, 'pipeline.insolation.status': 'confirme' }),
    ])
    res.json({ en_attente: enAttente, confirme })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /orders/:id/insolation — { status, note }
router.patch('/orders/:id/insolation', authorize('insolation'), async (req, res) => {
  try {
    const { status, note } = req.body
    if (!Order.INSOLATION_STATUS.includes(status)) {
      return res.status(400).json({ message: 'Statut insolation invalide' })
    }

    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    order.pipeline.insolation = {
      status,
      by:   req.user?.username || '',
      at:   new Date(),
      note: note !== undefined ? String(note).slice(0, 300) : (order.pipeline.insolation?.note || ''),
    }

    pushHistory(order, order.pipeline.stage, req,
      status === 'confirme' ? 'Insolation confirmée' : 'Insolation remise en attente')
    await order.save()
    await order.populate('pipeline.customTags')
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /orders/:id/custom-tags — étiquettes personnalisées d'une commande
// body: { tagIds: [ObjectId] } — remplace la liste pour le service concerné
router.patch('/orders/:id/custom-tags', authorize('confirmatrice', 'designer'), async (req, res) => {
  try {
    const Tag = require('../models/Tag')
    const ids = Array.isArray(req.body.tagIds) ? req.body.tagIds : []

    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    // On ne garde que des étiquettes réellement existantes
    const valid = await Tag.find({ _id: { $in: ids } }).select('_id')
    order.pipeline.customTags = valid.map(t => t._id)

    await order.save()
    await order.populate('pipeline.customTags')
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
// La note d'emballage est transmise au service de livraison.
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
    // « nouveau » = arrivée du site, pas encore traitée par la confirmatrice.
    // Les statuts, eux, sont des DÉCISIONS : « en attente » n'est donc pas
    // l'état par défaut d'une commande, mais un choix explicite.
    if (status === 'nouveau') {
      filter['pipeline.statusSetAt'] = null
    } else if (status && VALID_STATUSES.includes(status)) {
      filter.status = status
      filter['pipeline.statusSetAt'] = { $ne: null }
    }

    // Filtre par étiquette personnalisée
    if (req.query.tag && /^[0-9a-fA-F]{24}$/.test(req.query.tag)) {
      filter['pipeline.customTags'] = req.query.tag
    }

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
      .populate('pipeline.customTags')
      .sort({ createdAt: -1 })
      .limit(limit)

    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /confirmation/counts — compteurs des onglets et des étiquettes
router.get('/confirmation/counts', authorize('confirmatrice'), async (req, res) => {
  try {
    const [agg, nouveau, parTag] = await Promise.all([
      // Les compteurs de statut ne comptent que les décisions de la
      // confirmatrice, pas les commandes qui viennent d'arriver du site.
      Order.aggregate([
        { $match: { 'pipeline.statusSetAt': { $ne: null } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Order.countDocuments({ 'pipeline.statusSetAt': null }),
      // Nombre de commandes portant chaque étiquette
      Order.aggregate([
        { $unwind: '$pipeline.customTags' },
        { $group: { _id: '$pipeline.customTags', count: { $sum: 1 } } },
      ]),
    ])

    const counts = { 'en attente': 0, 'confirmé': 0, 'annulé': 0, total: nouveau, nouveau }
    agg.forEach(r => {
      if (r._id in counts) counts[r._id] = r.count
      counts.total += r.count
    })

    counts.tags = {}
    parTag.forEach(t => { counts.tags[String(t._id)] = t.count })

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
    if (workedStages.includes(order.pipeline.stage) && !canOverride(req)) {
      return res.status(409).json({
        message: `Commande déjà à l'étape « ${order.pipeline.stage} », statut non modifiable.`,
      })
    }

    const wasConfirmed = order.status === 'confirmé'

    order.status = status
    order.pipeline.stage = nextStage

    // La commande est traitée : elle quitte l'onglet « Commandes »
    order.pipeline.statusSetAt = new Date()
    order.pipeline.statusSetBy = req.user?.username || ''

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
// Le chef de production peut aussi modifier une commande déjà en fabrication.
router.put('/orders/:id', authorize('confirmatrice', 'chef_production'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    const workedStages = ['production', 'emballage', 'livraison', 'termine']
    if (workedStages.includes(order.pipeline.stage) && !canForce(req)) {
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
    // Saisie manuelle : la confirmatrice a déjà décidé du statut
    order.pipeline.statusSetAt = new Date()
    order.pipeline.statusSetBy = req.user?.username || ''
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

// PATCH /orders/:id/stage — forcer une étape (superadmin et chef de production)
router.patch('/orders/:id/stage', authorize('superadmin', 'chef_production'), async (req, res) => {
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
