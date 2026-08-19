// routes/tagRoutes.js — Étiquettes personnalisées (confirmatrice / designer)
const express = require('express')
const router  = express.Router()
const Tag     = require('../models/Tag')
const { TAG_SCOPES } = require('../models/Tag')
const Order   = require('../models/Order')
const { authenticateUser, authorize } = require('../middleware/auth')

router.use(authenticateUser)

// Seuls la confirmatrice et le designer gèrent des étiquettes
const canManage = authorize('confirmatrice', 'designer')

// GET /api/tags?scope=designer — liste des étiquettes d'un service
router.get('/', async (req, res) => {
  try {
    const filter = {}
    if (TAG_SCOPES.includes(req.query.scope)) filter.scope = req.query.scope
    const tags = await Tag.find(filter).sort({ name: 1 })
    res.json(tags)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// POST /api/tags — créer une étiquette { name, color, scope }
router.post('/', canManage, async (req, res) => {
  try {
    const { name, color, scope } = req.body
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Le nom de l\'étiquette est requis' })
    }
    if (!TAG_SCOPES.includes(scope)) {
      return res.status(400).json({ message: 'Service invalide' })
    }

    const clean = String(name).trim().slice(0, 30)
    const exists = await Tag.findOne({ scope, name: clean })
    if (exists) return res.status(409).json({ message: 'Cette étiquette existe déjà' })

    const tag = await Tag.create({
      name:      clean,
      color:     color || '#7c3aed',
      scope,
      createdBy: req.user?.username || '',
    })
    res.status(201).json(tag)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /api/tags/:id — renommer / recolorer
router.patch('/:id', canManage, async (req, res) => {
  try {
    const { name, color } = req.body
    const tag = await Tag.findById(req.params.id)
    if (!tag) return res.status(404).json({ message: 'Étiquette introuvable' })

    if (name !== undefined)  tag.name  = String(name).trim().slice(0, 30)
    if (color !== undefined) tag.color = color
    await tag.save()
    res.json(tag)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// DELETE /api/tags/:id — supprime l'étiquette et la retire des commandes
router.delete('/:id', canManage, async (req, res) => {
  try {
    const tag = await Tag.findByIdAndDelete(req.params.id)
    if (!tag) return res.status(404).json({ message: 'Étiquette introuvable' })

    await Order.updateMany(
      { 'pipeline.customTags': tag._id },
      { $pull: { 'pipeline.customTags': tag._id } }
    )
    res.json({ message: 'Étiquette supprimée' })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

module.exports = router
