const mongoose = require('mongoose')

// ── Matière première (stock) ─────────────────────────────────────────────────
// quantity = quantité ACTUELLE en stock. Elle est augmentée par le chef de
// production (réappro) et diminuée automatiquement par la production quand
// elle termine une fabrication (consommation).
const rawMaterialSchema = new mongoose.Schema(
  {
    name:              { type: String, required: true, trim: true },
    // Ce qui distingue deux matières du même nom : couleur, finition…
    // (« Sac 20*30 » blanc et « Sac 20*30 » noir sont deux lignes de stock)
    variant:           { type: String, default: '', trim: true },
    quantity:          { type: Number, required: true, default: 0, min: 0 },
    unit:              { type: String, default: 'unité', trim: true },   // unité, kg, m, rouleau…
    image:             { type: String, default: '' },                    // URL Cloudinary (optionnel)
    lowStockThreshold: { type: Number, default: 5, min: 0 },             // seuil d'alerte stock bas
    note:              { type: String, default: '' },
  },
  { timestamps: true }
)

// Recherche par nom + tri alphabétique fréquents dans la page stock
rawMaterialSchema.index({ name: 1 })

module.exports = mongoose.model('RawMaterial', rawMaterialSchema)
