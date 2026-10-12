// routes/stockRoutes.js — Gestion du stock de matières premières
const express       = require('express')
const router        = express.Router()
const RawMaterial   = require('../models/RawMaterial')
const StockMovement = require('../models/StockMovement')
const { authenticateUser, authorize } = require('../middleware/auth')

// Toutes les routes exigent une authentification staff
router.use(authenticateUser)

// Écriture du stock réservée au chef de production (+ superadmin via authorize)
const canWriteStock = authorize('chef_production')

// Nom affiché dans le journal : la variante distingue deux matières homonymes
const labelOf = (m) => (m.variant ? `${m.name} — ${m.variant}` : m.name)

/* ══════════════════════════════════════════════════════════════
   LECTURE — accessible à tout le staff authentifié
   (la production a besoin de voir les matières, le chef aussi)
══════════════════════════════════════════════════════════════ */

// GET /api/stock — liste des matières premières
router.get('/', async (req, res) => {
  try {
    const materials = await RawMaterial.find().sort({ name: 1, variant: 1, createdAt: 1 })
    res.json(materials)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/stock/stats — statistiques (agrégation, aucune donnée d'exemple)
router.get('/stats', async (req, res) => {
  try {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const [overview, lowStockItems, topConsumed, flow30] = await Promise.all([
      // Vue d'ensemble : nb de matières, total d'unités en stock
      RawMaterial.aggregate([
        {
          $group: {
            _id: null,
            totalMaterials: { $sum: 1 },
            totalUnits:     { $sum: '$quantity' },
            lowStockCount:  { $sum: { $cond: [{ $lte: ['$quantity', '$lowStockThreshold'] }, 1, 0] } },
            outOfStockCount:{ $sum: { $cond: [{ $eq: ['$quantity', 0] }, 1, 0] } },
          },
        },
      ]),
      // Matières en stock bas (quantité <= seuil)
      RawMaterial.find({ $expr: { $lte: ['$quantity', '$lowStockThreshold'] } })
        .select('name quantity unit lowStockThreshold image')
        .sort({ quantity: 1 })
        .limit(20),
      // Top matières consommées (30 derniers jours)
      StockMovement.aggregate([
        { $match: { type: 'out', createdAt: { $gte: since30 } } },
        { $group: { _id: '$materialName', totalOut: { $sum: '$quantity' } } },
        { $sort: { totalOut: -1 } },
        { $limit: 8 },
      ]),
      // Flux total entrées/sorties sur 30 jours
      StockMovement.aggregate([
        { $match: { createdAt: { $gte: since30 } } },
        { $group: { _id: '$type', total: { $sum: '$quantity' } } },
      ]),
    ])

    const ov   = overview[0] || { totalMaterials: 0, totalUnits: 0, lowStockCount: 0, outOfStockCount: 0 }
    const flow = { in: 0, out: 0, adjust: 0 }
    flow30.forEach(r => { flow[r._id] = r.total })

    res.json({
      totalMaterials:  ov.totalMaterials,
      totalUnits:      ov.totalUnits,
      lowStockCount:   ov.lowStockCount,
      outOfStockCount: ov.outOfStockCount,
      lowStockItems,
      topConsumed:     topConsumed.map(t => ({ name: t._id, total: t.totalOut })),
      restockedLast30: flow.in,
      consumedLast30:  flow.out,
    })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/stock/movements — historique des mouvements (paginé léger)
router.get('/movements', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    // ?material=<id> : l'historique d'une seule matière
    const filter = /^[0-9a-fA-F]{24}$/.test(String(req.query.material || ''))
      ? { material: req.query.material } : {}
    const movements = await StockMovement.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
    res.json(movements)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

/* ══════════════════════════════════════════════════════════════
   ÉCRITURE — chef de production (+ superadmin) uniquement
══════════════════════════════════════════════════════════════ */

// POST /api/stock — ajouter une matière première { name, quantity, unit, image, lowStockThreshold }
router.post('/', canWriteStock, async (req, res) => {
  try {
    const { name, variant, quantity, unit, image, lowStockThreshold, note } = req.body
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Le nom de la matière est requis' })
    }
    const qty = Number(quantity) || 0
    if (qty < 0) return res.status(400).json({ message: 'Quantité invalide' })

    const material = await RawMaterial.create({
      name: String(name).trim(),
      variant: String(variant || '').trim(),
      quantity: qty,
      unit: unit?.trim() || 'unité',
      image: image || '',
      lowStockThreshold: lowStockThreshold != null ? Number(lowStockThreshold) : 5,
      note: note || '',
    })

    // Journalise la quantité initiale comme entrée de stock
    if (qty > 0) {
      await StockMovement.create({
        material: material._id, materialName: labelOf(material),
        type: 'in', quantity: qty, delta: qty, by: req.user?.username || '',
        note: 'Quantité initiale',
      })
    }

    res.status(201).json(material)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /api/stock/:id/restock — réapprovisionner { quantity, note }
router.patch('/:id/restock', canWriteStock, async (req, res) => {
  try {
    const add = Number(req.body.quantity)
    if (!add || add <= 0) return res.status(400).json({ message: 'Quantité à ajouter invalide' })

    const material = await RawMaterial.findById(req.params.id)
    if (!material) return res.status(404).json({ message: 'Matière introuvable' })

    material.quantity += add
    await material.save()

    await StockMovement.create({
      material: material._id, materialName: labelOf(material),
      type: 'in', quantity: add, delta: add, by: req.user?.username || '',
      note: req.body.note || 'Réapprovisionnement',
    })

    res.json(material)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

/* POST /api/stock/:id/move  { type: 'in' | 'out' | 'set', quantity, note }
     in  : entrée (réception de marchandise)
     out : sortie hors commande (casse, perte, échantillon…)
     set : inventaire — on indique la quantité réellement comptée

   Le stock est modifié par une opération ATOMIQUE ($inc). L'ancienne méthode
   lisait la quantité, la modifiait puis réenregistrait la fiche : une
   déduction faite entre-temps par la confirmatrice était écrasée sans
   prévenir. Deux personnes peuvent maintenant agir en même temps. */
router.post('/:id/move', canWriteStock, async (req, res) => {
  try {
    const type = req.body.type
    const q    = Number(req.body.quantity)
    const note = String(req.body.note || '').trim().slice(0, 200)
    const by   = req.user?.username || ''

    if (!['in', 'out', 'set'].includes(type)) return res.status(400).json({ message: 'Type de mouvement invalide' })
    if (!Number.isFinite(q) || q < 0 || (type !== 'set' && q === 0)) {
      return res.status(400).json({ message: 'Quantité invalide' })
    }

    let before
    if (type === 'in') {
      before = await RawMaterial.findOneAndUpdate({ _id: req.params.id }, { $inc: { quantity: q } })
    } else if (type === 'out') {
      // La condition empêche de sortir plus que ce qu'il y a
      before = await RawMaterial.findOneAndUpdate(
        { _id: req.params.id, quantity: { $gte: q } }, { $inc: { quantity: -q } })
      if (!before) {
        const cur = await RawMaterial.findById(req.params.id)
        if (!cur) return res.status(404).json({ message: 'Matière introuvable' })
        return res.status(409).json({ message: `Stock insuffisant : il reste ${cur.quantity} ${cur.unit}.` })
      }
    } else {
      before = await RawMaterial.findOneAndUpdate({ _id: req.params.id }, { $set: { quantity: q } })
    }
    if (!before) return res.status(404).json({ message: 'Matière introuvable' })

    const delta = type === 'in' ? q : type === 'out' ? -q : q - before.quantity
    if (delta !== 0) {
      await StockMovement.create({
        material: before._id, materialName: labelOf(before),
        type: type === 'set' ? 'adjust' : type,
        quantity: Math.abs(delta), delta, by,
        note: note || (
          type === 'in'  ? 'Réapprovisionnement' :
          type === 'out' ? 'Sortie de stock' :
          `Inventaire : ${before.quantity} → ${q}`),
      })
    }

    res.json(await RawMaterial.findById(before._id))
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /api/stock/:id — modifier une matière (nom, unité, image, seuil, quantité=ajustement)
router.patch('/:id', canWriteStock, async (req, res) => {
  try {
    const { name, variant, unit, image, lowStockThreshold, quantity, note } = req.body
    const material = await RawMaterial.findById(req.params.id)
    if (!material) return res.status(404).json({ message: 'Matière introuvable' })

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ message: 'Le nom de la matière est requis' })
      material.name = String(name).trim()
    }
    if (variant !== undefined)           material.variant = String(variant || '').trim()
    if (unit !== undefined)              material.unit = unit?.trim() || 'unité'
    if (image !== undefined)             material.image = image
    if (lowStockThreshold !== undefined) material.lowStockThreshold = Number(lowStockThreshold)
    if (note !== undefined)              material.note = note

    // Ajustement manuel de la quantité → journalisé en 'adjust'
    if (quantity !== undefined && Number(quantity) !== material.quantity) {
      const newQty = Math.max(0, Number(quantity))
      const delta  = newQty - material.quantity
      material.quantity = newQty
      await StockMovement.create({
        material: material._id, materialName: labelOf(material),
        type: 'adjust', quantity: Math.abs(delta), delta, by: req.user?.username || '',
        note: note || `Ajustement manuel (${delta > 0 ? '+' : ''}${delta})`,
      })
    }

    await material.save()
    res.json(material)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// DELETE /api/stock/:id — supprimer une matière
router.delete('/:id', canWriteStock, async (req, res) => {
  try {
    const material = await RawMaterial.findByIdAndDelete(req.params.id)
    if (!material) return res.status(404).json({ message: 'Matière introuvable' })
    res.json({ message: 'Matière supprimée' })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

module.exports = router
