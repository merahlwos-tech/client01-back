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

    /* 0) Compte propriétaire (.env) EN PREMIER. Chercher d'abord en base
          laissait un compte homonyme intercepter la connexion : le vrai mot
          de passe échouait (401) et le propriétaire était exclu de son propre
          panneau. */
    if (
      process.env.ADMIN_USERNAME &&
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      const token = signToken({ username, role: 'admin' });
      return res.json({
        token,
        message: 'Connexion réussie',
        user: { username, role: 'admin' },
        admin: { username },   // compat rétro avec l'ancien front
      });
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
