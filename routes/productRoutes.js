// routes/productRoutes.js
const express  = require('express')
const router   = express.Router()
const multer   = require('multer')
const Product  = require('../models/Product')
const { authenticateAdmin } = require('../middleware/auth')
const { uploadProductImageToR2, deleteProductImageFromR2 } = require('../utils/uploadR2')

// Multer en mémoire — on gère l'upload nous-mêmes vers R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB max par image
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Fichier non image refusé'), false)
  },
})

// ─────────────────────────────────────────────
// GET tous les produits (public)
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category } = req.query
    const filter   = category ? { category } : {}
    const products = await Product.find(filter).sort({ createdAt: -1 })
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
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })
    res.json(product)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// POST créer un produit + upload images vers R2
// ─────────────────────────────────────────────
router.post('/', authenticateAdmin, upload.array('images', 5), async (req, res) => {
  try {
    // Parse les champs JSON envoyés en multipart
    const body = { ...req.body }
    if (typeof body.sizes === 'string')  body.sizes  = JSON.parse(body.sizes)
    if (typeof body.colors === 'string') body.colors = JSON.parse(body.colors)
    if (typeof body.tags === 'string')   body.tags   = JSON.parse(body.tags)
    if (typeof body.doubleSided === 'string') body.doubleSided = body.doubleSided === 'true'

    // Upload les images vers R2
    let imageUrls = []
    if (req.files && req.files.length > 0) {
      imageUrls = await Promise.all(
        req.files.map(file => uploadProductImageToR2(file.buffer))
      )
    }

    const product    = new Product({ ...body, images: imageUrls })
    const newProduct = await product.save()
    res.status(201).json(newProduct)
  } catch (error) {
    res.status(400).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// PUT modifier un produit (+ nouvelles images R2)
// ─────────────────────────────────────────────
router.put('/:id', authenticateAdmin, upload.array('images', 5), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })

    const body = { ...req.body }
    if (typeof body.sizes === 'string')  body.sizes  = JSON.parse(body.sizes)
    if (typeof body.colors === 'string') body.colors = JSON.parse(body.colors)
    if (typeof body.tags === 'string')   body.tags   = JSON.parse(body.tags)
    if (typeof body.doubleSided === 'string') body.doubleSided = body.doubleSided === 'true'

    // Si de nouvelles images sont envoyées, supprimer les anciennes R2 + uploader les nouvelles
    if (req.files && req.files.length > 0) {
      // Supprimer les anciennes images R2
      await Promise.all(product.images.map(deleteProductImageFromR2))

      // Uploader les nouvelles
      body.images = await Promise.all(
        req.files.map(file => uploadProductImageToR2(file.buffer))
      )
    }

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      body,
      { new: true, runValidators: true }
    )
    res.json(updated)
  } catch (error) {
    res.status(400).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// DELETE supprimer un produit + ses images R2
// ─────────────────────────────────────────────
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
    if (!product) return res.status(404).json({ message: 'Produit non trouvé' })

    // Supprimer les images R2
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