const express    = require('express')
const router     = express.Router()
const Order      = require('../models/Order')
const Product    = require('../models/Product')
const cloudinary = require('../config/cloudinary')
const { authenticateAdmin } = require('../middleware/auth')
const { sendMetaEvent }     = require('../utils/metaCAPI')
const { sendToEcotrack }    = require('../utils/ecotrack')
const { unitPriceFor }      = require('../utils/pricing')
const { applyStatus }       = require('../utils/orderStatus')

// Champs client modifiables depuis la fiche admin
const CUSTOMER_FIELDS = [
  'firstName', 'lastName', 'phone', 'extraPhones', 'wilaya', 'wilayaCode',
  'commune', 'description', 'logoUrls', 'deliveryMethod', 'deliveryFee',
]

// Plafond des frais de livraison acceptés du client (le plus cher des tarifs
// Ecotrack reste bien en dessous) : empêche un total gonflé ou négatif.
const MAX_DELIVERY_FEE = 3000

function extractCloudinaryPublicId(url) {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i)
    return match ? match[1] : null
  } catch { return null }
}

// ─── POST /api/orders ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { customerInfo, items, metaEventId, metaFbp, metaFbc } = req.body
    if (!customerInfo || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Données incomplètes' })
    }

    /* Le prix vient du CATALOGUE, jamais du navigateur. Le panier envoyait
       le prix de base de la taille en ignorant les paliers de quantité et le
       supplément couleurs : des commandes étaient enregistrées — et
       encaissées par Ecotrack — jusqu'à 58 % trop cher ou à moitié prix. */
    const cleanItems = []
    for (const item of items) {
      const quantity = Number(item.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) {
        return res.status(400).json({ message: `Quantité invalide pour ${item.name || 'un article'}` })
      }
      const product = await Product.findById(item.product).lean()
      if (!product) return res.status(404).json({ message: `Produit introuvable : ${item.name}` })

      const maxColors = Number(product.colorDesignMaxColors) || null
      let numberOfColors = item.numberOfColors != null ? Number(item.numberOfColors) : null
      if (numberOfColors != null) {
        numberOfColors = Math.max(1, Math.floor(numberOfColors) || 1)
        if (maxColors) numberOfColors = Math.min(numberOfColors, maxColors)
      }

      const price = unitPriceFor(product, item.size, quantity, !!item.doubleSided, numberOfColors)
      if (price == null) {
        return res.status(400).json({ message: `Taille ${item.size} introuvable pour ${product.name}` })
      }

      cleanItems.push({
        product:        product._id,
        name:           product.name,
        size:           item.size,
        doubleSided:    !!item.doubleSided,
        selectedColors: Array.isArray(item.selectedColors)
          ? item.selectedColors.map(String).slice(0, 10) : [],
        numberOfColors,
        quantity,
        price,
      })
    }

    /* Frais de livraison : le tarif Ecotrack est choisi côté client, mais on
       en borne la valeur et on applique ici la règle de gratuité (500 unités
       et plus en Stop Desk) — le client ne peut plus se l'attribuer. */
    const units = cleanItems.reduce((s, i) => s + i.quantity, 0)
    let deliveryFee = Number(customerInfo.deliveryFee)
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0) deliveryFee = 0
    deliveryFee = Math.min(deliveryFee, MAX_DELIVERY_FEE)
    if (units >= 500 && customerInfo.deliveryMethod === 'Stop Desk') deliveryFee = 0

    const total = cleanItems.reduce((s, i) => s + i.price * i.quantity, 0) + deliveryFee

    const order = new Order({
      customerInfo: { ...customerInfo, deliveryFee },
      items: cleanItems,
      total,
      status: 'en attente',
    })
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
            // Les articles vérifiés, et le total recalculé par le serveur
            content_ids: cleanItems.map(i => String(i.product)),
            content_type: 'product',
            num_items: units,
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

    /* Le statut passe par la MÊME règle que l'atelier (utils/orderStatus) :
       étape, compte à rebours, date d'annulation. Avant, seul `status`
       changeait — une commande confirmée ici restait invisible pour le
       designer, une annulée restait dans les listes de travail. On n'agit que
       si le statut change vraiment : la fiche le renvoie à chaque
       enregistrement, même pour corriger une adresse. */
    if (status !== undefined) {
      if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Statut invalide' })
      if (status !== order.status) {
        const actor = { username: req.admin?.username || 'admin', role: 'admin' }
        const stage = applyStatus(order, status, actor)
        order.pipeline.history.push({
          stage, by: actor.username, role: 'admin',
          note: `Statut → ${status} (panneau admin)`, at: new Date(),
        })
      }
    }

    /* Articles : la fiche admin ne connaît pas les couleurs sac/impression
       saisies par la confirmatrice et ne les renvoie pas. Remplacer la liste
       telle quelle les effaçait : on les reprend de l'article existant. */
    if (items !== undefined) {
      order.items = items.map((it, i) => {
        const prev = (it._id && order.items.id(it._id)) || order.items[i]
        return {
          ...it,
          bagColor:   it.bagColor   !== undefined ? it.bagColor   : (prev?.bagColor   || ''),
          printColor: it.printColor !== undefined ? it.printColor : (prev?.printColor || ''),
        }
      })
    }

    /* Client : liste blanche de champs. La fiche admin envoie le code de la
       wilaya sous le nom `wilayaId`, que le schéma ignorait : changer de
       wilaya gardait l'ancien code, et Ecotrack recevait une commune d'une
       wilaya avec le code d'une autre. */
    if (customerInfo !== undefined) {
      const ci = { ...customerInfo }
      if (ci.wilayaCode === undefined && ci.wilayaId !== undefined && ci.wilayaId !== '') {
        ci.wilayaCode = Number(ci.wilayaId) || null
      }
      for (const k of CUSTOMER_FIELDS) {
        if (ci[k] !== undefined) order.customerInfo[k] = ci[k]
      }
    }
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
