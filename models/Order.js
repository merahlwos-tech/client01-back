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

// ── Pipeline interne (atelier) ───────────────────────────────────────────────
// Étapes du workflow interne, indépendant du `status` public.
//   confirmation → design → production → emballage → livraison → termine
//   (ou `annulee` si la confirmatrice/superadmin annule)
const PIPELINE_STAGES = ['confirmation', 'design', 'production', 'emballage', 'livraison', 'termine', 'annulee']

// Une entrée d'historique par transition d'étape (traçabilité)
const pipelineHistorySchema = new mongoose.Schema({
  stage: { type: String },
  by:    { type: String },   // username de l'auteur
  role:  { type: String },
  note:  { type: String, default: '' },
  at:    { type: Date, default: Date.now },
}, { _id: false })

// Statuts du service insolation
const INSOLATION_STATUS = ['en_attente', 'confirme']

// Note libre ajoutée par n'importe quel service — visible par tous
const noteSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 500 },
  by:   { type: String, default: '' },
  role: { type: String, default: '' },
  at:   { type: Date,   default: Date.now },
})

// Matière première consommée par la production pour cette commande
const materialUsedSchema = new mongoose.Schema({
  material: { type: mongoose.Schema.Types.ObjectId, ref: 'RawMaterial' },
  name:     { type: String },
  quantity: { type: Number, default: 0 },
}, { _id: false })

// Niveaux d'urgence posés par la confirmatrice
const URGENCY_LEVELS = ['normal', 'urgent', 'tres_urgent']

// Étiquettes posées par le designer (client lent à répondre…)
const DESIGNER_TAGS = ['aucun', 'reponses_lentes']

// Délai accordé à l'atelier une fois la commande confirmée
const DEADLINE_DAYS = 6

const pipelineSchema = new mongoose.Schema({
  stage: { type: String, enum: PIPELINE_STAGES, default: 'confirmation' },

  // Étiquette d'urgence (visible par tous les services)
  urgency: { type: String, enum: URGENCY_LEVELS, default: 'normal' },

  // Étiquette posée par le designer (ex. client lent à répondre)
  designerTag: { type: String, enum: DESIGNER_TAGS, default: 'aucun' },

  // Étiquettes personnalisées créées par les services (modèle Tag)
  customTags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],

  // Compte à rebours : démarré quand la confirmatrice passe la commande
  // en « confirmé ». deadlineAt = confirmedAt + DEADLINE_DAYS jours.
  confirmedAt: { type: Date, default: null },
  deadlineAt:  { type: Date, default: null },

  // Commande saisie manuellement par la confirmatrice (≠ commande du site)
  manual: { type: Boolean, default: false },

  // Travail du designer
  design: {
    files:       { type: [String], default: [] },  // URLs des fichiers/design finalisés
    notes:       { type: String, default: '' },
    submittedAt: { type: Date,    default: null },
    by:          { type: String,  default: '' },
  },

  // Le designer a terminé son travail (« validé ») — la commande reste
  // chez lui tant qu'il ne l'a pas explicitement envoyée en production.
  designValidated:   { type: Boolean, default: false },
  designValidatedAt: { type: Date,    default: null },

  // Planification de la fabrication, choisie par le designer à l'envoi.
  //   productionDate : date réelle « YYYY-MM-DD » (calculée côté client,
  //                    donc dans le fuseau de l'atelier — pas de décalage)
  //   productionDay  : jour de la semaine 0=dimanche … 6=samedi (affichage)
  productionDate:     { type: String, default: '' },
  productionDay:      { type: Number, default: null, min: 0, max: 6 },
  sentToProductionAt: { type: Date,   default: null },

  // Consommation de matières par la production
  materialsUsed:   { type: [materialUsedSchema], default: [] },
  productionNotes: { type: String, default: '' },

  // Emballage
  packagingNotes:  { type: String, default: '' },

  // Fil de notes partagé : chaque service peut en ajouter, tous les voient
  notes: { type: [noteSchema], default: [] },

  // Service insolation — reçoit les commandes validées par le designer
  insolation: {
    status: { type: String, enum: INSOLATION_STATUS, default: 'en_attente' },
    by:     { type: String, default: '' },
    at:     { type: Date,   default: null },
    note:   { type: String, default: '' },
  },

  // Assignations / auteurs par étape (facultatif, pour affichage)
  confirmedBy:     { type: String, default: '' },

  history:         { type: [pipelineHistorySchema], default: [] },
}, { _id: false })

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
  ecotrackTracking:  { type: String,   default: null },  // numéro de tracking Ecotrack
  ecotrackSentAt:    { type: Date,     default: null },   // date d'envoi
  tags:              { type: [String], default: [] },

  // ── Pipeline interne (atelier) — additif, n'affecte pas le site public ──
  pipeline:          { type: pipelineSchema, default: () => ({}) },
}, { timestamps: true })

orderSchema.index({ createdAt: -1 })
orderSchema.index({ status: 1 })
orderSchema.index({ status: 1, total: 1 })
orderSchema.index({ tags: 1 })
// Requêtes fréquentes de l'atelier : lister les commandes d'une étape donnée
orderSchema.index({ 'pipeline.stage': 1, createdAt: -1 })
// La production interroge « les commandes à fabriquer aujourd'hui »
orderSchema.index({ 'pipeline.stage': 1, 'pipeline.productionDate': 1 })

module.exports = mongoose.model('Order', orderSchema)
module.exports.PIPELINE_STAGES = PIPELINE_STAGES
module.exports.URGENCY_LEVELS  = URGENCY_LEVELS
module.exports.DESIGNER_TAGS     = DESIGNER_TAGS
module.exports.DEADLINE_DAYS     = DEADLINE_DAYS
module.exports.INSOLATION_STATUS = INSOLATION_STATUS
