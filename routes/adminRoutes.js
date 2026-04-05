const express  = require('express')
const router   = express.Router()
const https    = require('https')
const Order    = require('../models/Order')
const Settings = require('../models/Settings')
const { authenticateAdmin } = require('../middleware/auth')

/* ─────────────────────────────────────────────────────────────
   TELEGRAM CONFIG (tout en dur, pas de .env)
   ─────────────────────────────────────────────────────────── */
const TELEGRAM_TOKEN = '8137759752:AAFf-16JebT60HNKrIBi_iZbC0dALGSYoTc'

/* Utilitaire : appel HTTPS simple vers l'API Telegram */
function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${TELEGRAM_TOKEN}/${method}`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve({ ok: false, raw: data }) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(new Error('Telegram timeout')) })
    req.write(body)
    req.end()
  })
}

/* Utilitaire : récupère le chat_id depuis la BDD ou via getUpdates */
async function resolveChatId() {
  // 1. Essai depuis la BDD (déjà découvert)
  const stored = await Settings.findOne({ key: 'telegramChatId' })
  if (stored?.value) return stored.value

  // 2. Auto-découverte via getUpdates
  const upd = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${TELEGRAM_TOKEN}/getUpdates`,
      method:   'GET',
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve({ ok: false }) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')) })
    req.end()
  })

  if (!upd.ok || !upd.result?.length) return null

  const lastUpdate = upd.result[upd.result.length - 1]
  const chatId =
    lastUpdate?.message?.chat?.id ??
    lastUpdate?.channel_post?.chat?.id ??
    null

  if (!chatId) return null

  // Sauvegarde en BDD pour les prochains appels
  await Settings.findOneAndUpdate(
    { key: 'telegramChatId' },
    { value: chatId },
    { upsert: true }
  )
  return chatId
}

/* ─────────────────────────────────────────────────────────────
   GET /admin/stats
   ─────────────────────────────────────────────────────────── */
router.get('/stats', authenticateAdmin, async (req, res) => {
  try {
    const [agg, totalOrders] = await Promise.all([
      Order.aggregate([
        {
          $group: {
            _id:     '$status',
            count:   { $sum: 1 },
            revenue: { $sum: '$total' },
          },
        },
      ]),
      Order.countDocuments(),
    ])

    const byStatus = {}
    agg.forEach(row => { byStatus[row._id] = row })

    const confirmed = byStatus['confirme']   || { count: 0, revenue: 0 }
    const pending   = byStatus['en attente'] || { count: 0 }
    const cancelled = byStatus['annule']     || { count: 0 }

    res.json({
      totalOrders,
      totalRevenue:    confirmed.revenue,
      confirmedOrders: confirmed.count,
      pendingOrders:   pending.count,
      cancelledOrders: cancelled.count,
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   POST /admin/stats/reset
   ─────────────────────────────────────────────────────────── */
router.post('/stats/reset', authenticateAdmin, async (req, res) => {
  try {
    const result = await Order.deleteMany({ status: 'annulé' })
    res.json({ message: 'Commandes annulées supprimées', deletedCount: result.deletedCount })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   GET /admin/hidden-categories
   Retourne la liste des catégories actuellement cachées
   ─────────────────────────────────────────────────────────── */
router.get('/hidden-categories', authenticateAdmin, async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'hiddenCategories' })
    res.json(setting?.value || [])
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   POST /admin/hidden-categories
   Met à jour la liste des catégories cachées
   body: { categories: ['Board', 'Bags', ...] }
   ─────────────────────────────────────────────────────────── */
router.post('/hidden-categories', authenticateAdmin, async (req, res) => {
  try {
    const { categories } = req.body
    if (!Array.isArray(categories)) {
      return res.status(400).json({ message: 'categories doit être un tableau' })
    }
    await Settings.findOneAndUpdate(
      { key: 'hiddenCategories' },
      { value: categories },
      { upsert: true, new: true }
    )
    res.json({ message: 'Catégories mises à jour', categories })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   GET /admin/telegram/discover
   Auto-découverte du chat_id depuis getUpdates.
   Appeler UNE FOIS après avoir envoyé un message au bot.
   ─────────────────────────────────────────────────────────── */
router.get('/telegram/discover', authenticateAdmin, async (req, res) => {
  try {
    const chatId = await resolveChatId()
    if (!chatId) {
      return res.status(404).json({
        message: "Aucun message trouvé. Envoyez d'abord un message à votre bot Telegram puis réessayez.",
      })
    }
    res.json({ chatId, message: 'Chat ID découvert et enregistré automatiquement.' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   POST /admin/signaler
   Envoie un numéro de téléphone signalé au bot Telegram de l'admin
   body: { phone: '0xxxxxxxxx' }
   ─────────────────────────────────────────────────────────── */
router.post('/signaler', authenticateAdmin, async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ message: 'Numéro requis' })

    const chatId = await resolveChatId()
    if (!chatId) {
      return res.status(503).json({
        message: "Chat Telegram non configuré. Appelez d'abord GET /api/admin/telegram/discover depuis le dashboard admin.",
      })
    }

    const now = new Date().toLocaleString('fr-DZ', {
      timeZone: 'Africa/Algiers',
      dateStyle: 'short',
      timeStyle: 'short',
    })

    const text =
      `🚨 *SIGNALEMENT*\n\n` +
      `📞 Numéro : \`${phone}\`\n` +
      `🕐 Date : ${now}`

    const result = await telegramRequest('sendMessage', {
      chat_id:    chatId,
      text,
      parse_mode: 'Markdown',
    })

    if (!result.ok) {
      return res.status(502).json({ message: 'Erreur Telegram', detail: result })
    }

    res.json({ message: 'Signalement envoyé avec succès.' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

module.exports = router
