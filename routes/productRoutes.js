const express  = require('express')
const router   = express.Router()
const Product  = require('../models/Product')
const { authenticateAdmin } = require('../middleware/auth')
const { deleteProductImageFromR2 } = require('../utils/uploadR2')

// ─────────────────────────────────────────────
// GET tous les produits (public)
// .lean() → retourne des objets JS purs (pas d'instances Mongoose)
//           → 2× plus rapide en lecture, moins de mémoire
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category } = req.query
    const filter   = category ? { category } : {}
    const products = await Product
      .find(filter)
      .sort({ createdAt: -1 })
      .lean()            // ← optimisation lecture
    res.json(products)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// GET un produit par ID (public)
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean()
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })
    res.json(product)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// POST créer un produit (admin)
// ─────────────────────────────────────────────
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const body = { ...req.body }
    if (typeof body.sizes === 'string')       body.sizes       = JSON.parse(body.sizes)
    if (typeof body.colors === 'string')      body.colors      = JSON.parse(body.colors)
    if (typeof body.tags === 'string')        body.tags        = JSON.parse(body.tags)
    if (typeof body.doubleSided === 'string') body.doubleSided = body.doubleSided === 'true'
    if (body.images && !Array.isArray(body.images)) body.images = [body.images]
    if (!body.images) body.images = []

    const product    = new Product(body)
    const newProduct = await product.save()
    res.status(201).json(newProduct)
  } catch (error) {
    res.status(400).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// PUT modifier un produit (admin)
// ─────────────────────────────────────────────
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })

    const body = { ...req.body }
    if (typeof body.sizes === 'string')       body.sizes       = JSON.parse(body.sizes)
    if (typeof body.colors === 'string')      body.colors      = JSON.parse(body.colors)
    if (typeof body.tags === 'string')        body.tags        = JSON.parse(body.tags)
    if (typeof body.doubleSided === 'string') body.doubleSided = body.doubleSided === 'true'
    if (body.images && !Array.isArray(body.images)) body.images = [body.images]
    if (!body.images || body.images.length === 0) body.images = product.images

    const updated = await Product.findByIdAndUpdate(
      req.params.id, body,
      { new: true, runValidators: true }
    )
    res.json(updated)
  } catch (error) {
    res.status(400).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// DELETE supprimer un produit + images R2 (admin)
// ─────────────────────────────────────────────
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })

    if (product.images?.length > 0) {
      await Promise.all(product.images.map(deleteProductImageFromR2))
    }
    await Product.findByIdAndDelete(req.params.id)
    res.json({ message: 'Produit et images supprimés' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

module.exports = router