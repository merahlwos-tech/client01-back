const express    = require('express')
const router     = express.Router()
const Order      = require('../models/Order')
const Product    = require('../models/Product')
const cloudinary = require('../config/cloudinary')
const { authenticateAdmin } = require('../middleware/auth')
const { sendMetaEvent }     = require('../utils/metaCAPI')
const { sendToEcotrack }    = require('../utils/ecotrack')

function extractCloudinaryPublicId(url) {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i)
    return match ? match[1] : null
  } catch { return null }
}

// ─── POST /api/orders ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { customerInfo, items, total, metaEventId, metaFbp, metaFbc } = req.body
    if (!customerInfo || !items || !total) {
      return res.status(400).json({ message: 'Données incomplètes' })
    }

    for (const item of items) {
      const product = await Product.findById(item.product)
      if (!product) return res.status(404).json({ message: `Produit introuvable : ${item.name}` })
      const sizeData = product.sizes.find((s) => s.size == item.size)
      if (!sizeData) return res.status(400).json({ message: `Taille ${item.size} introuvable pour ${item.name}` })
    }

    const order = new Order({ customerInfo, items, total, status: 'en attente' })
    await order.save()

    // Meta CAPI Purchase (fire-and-forget)
    setImmediate(async () => {
      try {
        const ip = (
          req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
          req.headers['x-real-ip'] ||
          req.socket?.remoteAddress || ''
        ).replace('::ffff:', '')

        await sendMetaEvent('Purchase', {
          eventId:   metaEventId || undefined,
          sourceUrl: req.headers['referer'] || '',
          userData: {
            phone: customerInfo.phone, firstName: customerInfo.firstName,
            lastName: customerInfo.lastName, wilaya: customerInfo.wilaya,
            commune: customerInfo.commune, ip, userAgent: req.headers['user-agent'],
            ...(metaFbp && { fbp: metaFbp }),
            ...(metaFbc && { fbc: metaFbc }),
          },
          customData: {
            order_id: order._id.toString(),
            content_ids: items.map(i => String(i.product)),
            content_type: 'product',
            num_items: items.reduce((s, i) => s + i.quantity, 0),
            value: total, currency: 'DZD',
          },
        })
      } catch (err) { console.error('Meta CAPI Purchase error:', err.message) }
    })

    res.status(201).json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// ─── GET /api/orders ─────────────────────────────────────────────────────────
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('items.product', 'name brand images')
      .sort({ createdAt: -1 })
    res.json(orders)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// ─── GET /api/orders/:id ─────────────────────────────────────────────────────
router.get('/:id', authenticateAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('items.product', 'name brand images')
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })
    res.json(order)
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// ─── PUT /api/orders/:id ─────────────────────────────────────────────────────
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status, items, customerInfo, total } = req.body
    const validStatuses = ['en attente', 'confirmé', 'annulé']

    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    const wasConfirmed = order.status === 'confirmé'

    if (status !== undefined) {
      if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Statut invalide' })
      order.status = status
    }
    if (items !== undefined)        order.items = items
    if (customerInfo !== undefined) Object.assign(order.customerInfo, customerInfo)
    if (total !== undefined)        order.total = total

    // ── Auto-envoi Ecotrack quand status → confirmé ──────────────────────────
    let ecotrackResult = null
    if (status === 'confirmé' && !wasConfirmed && !order.ecotrackTracking) {
      try {
        ecotrackResult = await sendToEcotrack(order)
      } catch (err) {
        console.error('[ECOTRACK] Erreur auto-envoi:', err.message)
        ecotrackResult = { error: err.message }
      }
    }

    await order.save()

    // Retourne la commande + résultat Ecotrack
    res.json({
      ...order.toObject(),
      _ecotrackResult: ecotrackResult,
    })

  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// ─── DELETE /api/orders/:id ──────────────────────────────────────────────────
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
    if (!order) return res.status(404).json({ message: 'Commande introuvable' })

    const logoUrls = order.customerInfo?.logoUrls || []
    if (logoUrls.length > 0) {
      await Promise.all(logoUrls.map(url => {
        const publicId = extractCloudinaryPublicId(url)
        if (!publicId) return Promise.resolve()
        return cloudinary.uploader.destroy(publicId).catch(err =>
          console.error('Cloudinary delete error:', publicId, err.message)
        )
      }))
    }

    await Order.findByIdAndDelete(req.params.id)
    res.json({ message: 'Commande et logos supprimés' })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

module.exports = router
