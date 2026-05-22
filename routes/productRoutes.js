const express  = require('express')
const router   = express.Router()
const Product  = require('../models/Product')
const Settings = require('../models/Settings')
const { authenticateAdmin } = require('../middleware/auth')
const { deleteProductImageFromR2 } = require('../utils/uploadR2')

/* ─────────────────────────────────────────────────────────────
   GET /products  — route publique
   Filtre automatiquement les catégories cachées par l'admin
   ─────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const { category } = req.query

    // Récupère les catégories cachées
    const hiddenSetting = await Settings.findOne({ key: 'hiddenCategories' }).lean()
    const hidden = hiddenSetting?.value || []

    const filter = {}

    if (category) {
      // Si la catégorie demandée est cachée → liste vide
      if (hidden.includes(category)) return res.json([])
      filter.category = category
    } else {
      // Exclut toutes les catégories cachées
      if (hidden.length > 0) {
        filter.category = { $nin: hidden }
      }
    }

    const products = await Product.find(filter).sort({ position: 1, createdAt: 1 }).lean()
    res.json(products)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   PUT /products/reorder  — admin seulement
   DOIT être avant /:id pour ne pas être capté par Express comme id
   body: [{ id: '...', position: 0 }, { id: '...', position: 1 }, ...]
   ─────────────────────────────────────────────────────────── */
router.put('/reorder', authenticateAdmin, async (req, res) => {
  try {
    const items = req.body
    if (!Array.isArray(items)) return res.status(400).json({ message: 'Array requis' })
    await Promise.all(
      items.map(({ id, position }) =>
        Product.findByIdAndUpdate(id, { position: Number(position) })
      )
    )
    res.json({ message: 'Ordre mis à jour' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   GET /products/:id
   ─────────────────────────────────────────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean()
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })
    res.json(product)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   POST /products  — admin seulement
   ─────────────────────────────────────────────────────────── */
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const body = { ...req.body }
    if (typeof body.sizes === 'string')              body.sizes              = JSON.parse(body.sizes)
    if (typeof body.colors === 'string')             body.colors             = JSON.parse(body.colors)
    if (typeof body.tags === 'string')               body.tags               = JSON.parse(body.tags)
    if (typeof body.doubleSided === 'string')        body.doubleSided        = body.doubleSided === 'true'
    if (typeof body.colorDesignEnabled === 'string') body.colorDesignEnabled = body.colorDesignEnabled === 'true'
    if (body.images && !Array.isArray(body.images)) body.images = [body.images]
    if (!body.images) body.images = []

    const product    = new Product(body)
    const newProduct = await product.save()
    res.status(201).json(newProduct)
  } catch (error) {
    res.status(400).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   PUT /products/:id  — admin seulement
   ─────────────────────────────────────────────────────────── */
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })

    const body = { ...req.body }
    if (typeof body.sizes === 'string')              body.sizes              = JSON.parse(body.sizes)
    if (typeof body.colors === 'string')             body.colors             = JSON.parse(body.colors)
    if (typeof body.tags === 'string')               body.tags               = JSON.parse(body.tags)
    if (typeof body.doubleSided === 'string')        body.doubleSided        = body.doubleSided === 'true'
    if (typeof body.colorDesignEnabled === 'string') body.colorDesignEnabled = body.colorDesignEnabled === 'true'
    if (body.images && !Array.isArray(body.images)) body.images = [body.images]
    if (!body.images || body.images.length === 0)   body.images = product.images

    // Reconstruire sizes proprement avec priceTiers
    if (Array.isArray(body.sizes)) {
      const newSizes = body.sizes.map(s => ({
        size:  String(s.size || ''),
        price: Number(s.price) || 0,
        priceTiers: Array.isArray(s.priceTiers)
          ? s.priceTiers
              .filter(t => t.qty != null && t.price != null && t.qty !== '' && t.price !== '')
              .map(t => ({ qty: Number(t.qty), price: Number(t.price) }))
              .sort((a, b) => a.qty - b.qty)
          : [],
      }))
      // Remplacer le tableau entier — markModified est OBLIGATOIRE
      // pour que Mongoose détecte les changements dans les sous-documents imbriqués
      product.sizes = newSizes
      product.markModified('sizes')
    }

    // Appliquer les autres champs
    const { sizes: _, ...rest } = body
    Object.keys(rest).forEach(key => {
      product[key] = rest[key]
    })

    const updated = await product.save()
    res.json(updated)
  } catch (error) {
    res.status(400).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   DELETE /products/:id  — admin seulement
   ─────────────────────────────────────────────────────────── */
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
