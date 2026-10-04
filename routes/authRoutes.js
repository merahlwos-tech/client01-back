// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

// ─────────────────────────────────────────────────────────────────────────────
// POST /login
// 1) Cherche un compte staff en base (confirmatrice, designer, production…)
// 2) Sinon, retombe sur le compte .env (propriétaire = superadmin de secours)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Identifiants requis' });
    }

    // 1) Compte staff en base ------------------------------------------------
    const user = await User.findOne({ username: String(username).toLowerCase().trim() });
    if (user) {
      if (!user.active) return res.status(403).json({ message: 'Compte désactivé' });
      const ok = await user.verifyPassword(password);
      if (!ok) return res.status(401).json({ message: 'Identifiants incorrects' });

      const token = signToken({ userId: user._id, username: user.username, role: user.role });
      return res.json({
        token,
        message: 'Connexion réussie',
        user: { username: user.username, role: user.role, fullName: user.fullName },
      });
    }

    // 2) Compte .env legacy (propriétaire) -----------------------------------
    if (
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const token = signToken({ username, role: 'admin' });
      return res.json({
        token,
        message: 'Connexion réussie',
        // 'admin' est traité comme superadmin côté plateforme interne
        user: { username, role: 'admin' },
        admin: { username },   // compat rétro avec l'ancien front
      });
    }

    res.status(401).json({ message: 'Identifiants incorrects' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /verify — vérifie le token, renvoie le rôle
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verify', (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true, user: decoded, admin: decoded });
  } catch (error) {
    res.status(401).json({ valid: false });
  }
});

module.exports = router;
