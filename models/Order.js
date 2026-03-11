const mongoose = require('mongoose')

const orderItemSchema = new mongoose.Schema({
  product:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name:        { type: String, required: true },
  size:        { type: String },
  doubleSided: { type: Boolean, default: false },
  quantity:    { type: Number, required: true },
  price:       { type: Number, required: true },
})

const customerInfoSchema = new mongoose.Schema({
  firstName:   { type: String, required: true },
  lastName:    { type: String, required: true },
  phone:       { type: String, required: true },
  wilaya:      { type: String, required: true },
  commune:     { type: String, required: true },
  description: { type: String, required: true },
  logoUrls:    { type: [String], required: true },
}, { _id: false })

const orderSchema = new mongoose.Schema({
  customerInfo: { type: customerInfoSchema, required: true },
  items:        { type: [orderItemSchema],  required: true },
  total:        { type: Number, required: true },
  status: {
    type:    String,
    enum:    ['en attente', 'confirmé', 'en livraison', 'livré', 'retour', 'annulé'],
    default: 'en attente',
  },
}, { timestamps: true })

// ── Index ──────────────────────────────────────────────────────────────────
// Accélère le tri par date (liste admin, toujours triée par -createdAt)
orderSchema.index({ createdAt: -1 })
// Accélère les filtres par statut (stats admin, très fréquents)
orderSchema.index({ status: 1 })
// Index composé pour les stats (status + total en un seul scan)
orderSchema.index({ status: 1, total: 1 })

module.exports = mongoose.model('Order', orderSchema)