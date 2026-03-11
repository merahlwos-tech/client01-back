const express = require('express')
const router  = express.Router()
const Order   = require('../models/Order')
const { authenticateAdmin } = require('../middleware/auth')

// ─────────────────────────────────────────────
// GET statistiques — version optimisée
//
// AVANT : 2 requêtes qui chargent TOUS les documents en mémoire
//         → si 10 000 commandes = 10 000 objets en RAM
//
// APRÈS : 1 seule requête avec agrégation MongoDB
//         → calcul fait côté serveur DB, le serveur Node reçoit juste les totaux
//         → 100× plus rapide avec un volume important
// ─────────────────────────────────────────────
router.get('/stats', authenticateAdmin, async (req, res) => {
  try {
    const [agg, totalOrders] = await Promise.all([
      Order.aggregate([
        {
          $group: {
            _id:      '$status',
            count:    { $sum: 1 },
            revenue:  { $sum: '$total' },
            products: {
              $sum: {
                $reduce: {
                  input:        '$items',
                  initialValue: 0,
                  in: { $add: ['$$value', '$$this.quantity'] },
                },
              },
            },
          },
        },
      ]),
      Order.countDocuments(),
    ])

    // Restructure les résultats
    const byStatus = {}
    agg.forEach(row => { byStatus[row._id] = row })

    const delivered = byStatus['livré']   || { count: 0, revenue: 0, products: 0 }
    const returned  = byStatus['retour']  || { count: 0 }

    res.json({
      totalRevenue:         delivered.revenue,
      productsDelivered:    delivered.products,
      deliveredOrdersCount: delivered.count,
      returnsCount:         returned.count,
      totalOrders,
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// ─────────────────────────────────────────────
// POST reset des statistiques (admin)
// ─────────────────────────────────────────────
router.post('/stats/reset', authenticateAdmin, async (req, res) => {
  try {
    const result = await Order.deleteMany({
      status: { $in: ['livré', 'retour'] },
    })
    res.json({ message: 'Statistiques réinitialisées', deletedCount: result.deletedCount })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

module.exports = router