// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/orders',   require('./routes/orderRoutes'));
app.use('/api/auth',     require('./routes/authRoutes'));
app.use('/api/upload',   require('./routes/uploadRoutes'));
app.use('/api/admin',    require('./routes/adminRoutes'));
app.use('/api/meta',     require('./routes/metaRoutes'));  // Meta CAPI

// Connexion MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ Erreur MongoDB:', err));

// Route de test
app.get('/', (req, res) => {
  res.json({ message: 'API Sneakers Store' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});