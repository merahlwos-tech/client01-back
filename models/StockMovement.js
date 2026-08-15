const mongoose = require('mongoose')

// ── Mouvement de stock (historique / statistiques) ───────────────────────────
// Chaque entrée/sortie de stock est journalisée ici. Sert de base aux
// statistiques de la page stock (consommation, réappro, tendances) sans avoir
// à recalculer à partir des commandes.
//   in     : réappro par le chef de production (ou création de matière)
//   out    : consommation par la production lors d'une fabrication terminée
//   adjust : correction manuelle du stock par un superadmin
const stockMovementSchema = new mongoose.Schema(
  {
    material:     { type: mongoose.Schema.Types.ObjectId, ref: 'RawMaterial', required: true },
    materialName: { type: String, required: true },   // snapshot (survit à une suppression)
    type:         { type: String, enum: ['in', 'out', 'adjust'], required: true },
    quantity:     { type: Number, required: true },   // quantité du mouvement (toujours positive)
    order:        { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null }, // si lié à une commande
    by:           { type: String, default: '' },      // username de l'auteur
    note:         { type: String, default: '' },
  },
  { timestamps: true }
)

// Agrégations fréquentes : par matière, par type, par date
stockMovementSchema.index({ material: 1, createdAt: -1 })
stockMovementSchema.index({ type: 1, createdAt: -1 })
stockMovementSchema.index({ createdAt: -1 })

module.exports = mongoose.model('StockMovement', stockMovementSchema)
