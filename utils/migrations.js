// utils/migrations.js
// Petites mises à niveau de données, exécutées au démarrage.
// Chacune doit être idempotente : relancée, elle ne fait rien de plus.

const Order = require('../models/Order')

/* `pipeline.statusSetAt` distingue les commandes déjà traitées par la
   confirmatrice. Il n'existait pas auparavant : les commandes dont le statut
   n'est plus « en attente » ont donc bien été décidées, on les marque comme
   telles pour qu'elles ne réapparaissent pas dans l'onglet « Commandes ». */
async function backfillStatusSetAt() {
  const res = await Order.updateMany(
    { 'pipeline.statusSetAt': null, status: { $ne: 'en attente' } },
    [{ $set: { 'pipeline.statusSetAt': '$updatedAt', 'pipeline.statusSetBy': 'historique' } }]
  )
  if (res.modifiedCount > 0) {
    console.log(`🔧 [MIGRATION] ${res.modifiedCount} commande(s) marquée(s) comme déjà traitées`)
  }
  return res.modifiedCount
}

async function runMigrations() {
  try {
    await backfillStatusSetAt()
  } catch (err) {
    console.error('[MIGRATION] erreur:', err.message)
  }
}

module.exports = { runMigrations, backfillStatusSetAt }
