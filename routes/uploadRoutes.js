// routes/uploadRoutes.js
const express = require('express')
const router  = express.Router()
const multer  = require('multer')
const { uploadProductImageToR2 } = require('../utils/uploadR2')
const { authenticateAdmin } = require('../middleware/auth')

const storage = multer.memoryStorage()
const upload  = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Seules les images sont autorisées'), false)
  },
})

// POST /api/upload — Upload images produit vers Cloudflare R2 (admin uniquement)
router.post('/', authenticateAdmin, upload.array('images', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'Aucune image fournie' })
    }

    const urls = await Promise.all(
      req.files.map(file => uploadProductImageToR2(file.buffer))
    )

    res.json({ message: 'Images uploadées avec succès', urls })
  } catch (error) {
    console.error('R2 upload error:', error)
    res.status(500).json({ message: error.message })
  }
})

module.exports = router