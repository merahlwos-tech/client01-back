const express      = require('express')
const mongoose     = require('mongoose')
const cors         = require('cors')
const compression  = require('compression')
const helmet       = require('helmet')
const rateLimit    = require('express-rate-limit')
require('dotenv').config()

const app = express()

// Render (et la plupart des hébergeurs) passent par un proxy
// Cette ligne dit à Express de faire confiance au header X-Forwarded-For
// → nécessaire pour que le rate limiter identifie correctement les IPs
app.set('trust proxy', 1)

/* ══════════════════════════════════════════════
   SÉCURITÉ & PERFORMANCE — Middleware globaux
══════════════════════════════════════════════ */

// 1. Headers de sécurité HTTP (XSS, clickjacking, sniffing…)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // autorise les images CDN
}))

// 2. Compression gzip/brotli des réponses JSON
//    → taille des réponses divisée par 5 à 10 sur les grandes listes
app.use(compression())

// 3. CORS ouvert — à restreindre plus tard avec ALLOWED_ORIGINS
app.use(cors())

// 4. Limite la taille des requêtes JSON (protège contre les payloads géants)
app.use(express.json({ limit: '2mb' }))

/* ══════════════════════════════════════════════
   RATE LIMITING
══════════════════════════════════════════════ */

// Limite générale : 100 req/min par IP
const generalLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de requêtes, réessayez dans une minute.' },
})

// Limite stricte sur la création de commandes : 10 req/15min par IP
// → protège contre le spam de commandes
const orderLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Trop de commandes soumises. Réessayez dans 15 minutes.' },
})

/* ══════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════ */
app.use('/api/products', generalLimit, require('./routes/productRoutes'))
app.use('/api/orders',   orderLimit,   require('./routes/orderRoutes'))
app.use('/api/auth',     generalLimit, require('./routes/authRoutes'))
app.use('/api/upload',   generalLimit, require('./routes/uploadRoutes'))
app.use('/api/admin',    generalLimit, require('./routes/adminRoutes'))
app.use('/api/meta',     generalLimit, require('./routes/metaRoutes'))
app.use('/api/ecotrack', generalLimit, require('./routes/ecotrackRoutes'))

/* ══════════════════════════════════════════════
   MONGODB
══════════════════════════════════════════════ */
mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: 10,           // Pool de connexions (défaut 5 → 10 pour plus de concurrence)
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ Erreur MongoDB:', err))

/* ══════════════════════════════════════════════
   HEALTH CHECK
══════════════════════════════════════════════ */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: Math.floor(process.uptime()),
  })
})

// Route de base (compatible avec l'existant)
app.get('/', (req, res) => res.json({ message: 'BrandPack API' }))

/* ══════════════════════════════════════════════
   GESTION D'ERREURS GLOBALE
══════════════════════════════════════════════ */
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(err.status || 500).json({
    message: err.message || 'Erreur serveur interne',
  })
})

const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`🚀 Serveur lancé sur le port ${PORT}`))