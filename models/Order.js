const mongoose = require('mongoose')

const orderItemSchema = new mongoose.Schema({
  product:        { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name:           { type: String, required: true },
  size:           { type: String },
  doubleSided:    { type: Boolean, default: false },
  selectedColors: { type: [String], default: [] },   // couleurs choisies par le client
  numberOfColors: { type: Number,   default: null },  // nb de couleurs dans le design
  quantity:       { type: Number, required: true },
  price:          { type: Number, required: true },
})

const customerInfoSchema = new mongoose.Schema({
  firstName:      { type: String, required: true },
  lastName:       { type: String, required: true },
  phone:          { type: String, required: true },
  wilaya:         { type: String, required: true },
  wilayaCode:     { type: Number, default: null },   // code numérique 1-58 pour Ecotrack
  commune:        { type: String, required: true },
  description:    { type: String, default: '' },
  logoUrls:       { type: [String], default: [] },
  deliveryMethod: { type: String, default: 'Domicile' },
  deliveryFee:    { type: Number, default: null },
}, { _id: false })

const orderSchema = new mongoose.Schema({
  customerInfo:      { type: customerInfoSchema, required: true },
  items:             { type: [orderItemSchema],  required: true },
  total:             { type: Number, required: true },
  status: {
    type:    String,
    enum:    ['en attente', 'confirmé', 'annulé'],
    default: 'en attente',
  },
  ecotrackTracking:  { type: String, default: null },  // numéro de tracking Ecotrack
  ecotrackSentAt:    { type: Date,   default: null },   // date d'envoi
}, { timestamps: true })

orderSchema.index({ createdAt: -1 })
orderSchema.index({ status: 1 })
orderSchema.index({ status: 1, total: 1 })

module.exports = mongoose.model('Order', orderSchema)