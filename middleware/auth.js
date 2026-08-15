// middleware/auth.js
const jwt = require('jsonwebtoken');

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY — auth admin e-commerce (inchangé). Utilisé par les routes existantes
// (products/orders/upload/admin). Le compte .env produit un token role='admin'.
// ─────────────────────────────────────────────────────────────────────────────
const authenticateAdmin = (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ message: 'Accès refusé. Token manquant.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 'admin' (compte .env) OU 'superadmin' ont accès au panneau e-commerce
    if (decoded.role !== 'admin' && decoded.role !== 'superadmin') {
      return res.status(403).json({ message: 'Accès refusé. Admin uniquement.' });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token invalide' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PLATEFORME INTERNE — vérifie le token et attache req.user = { userId, username, role }
// ─────────────────────────────────────────────────────────────────────────────
const authenticateUser = (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Accès refusé. Token manquant.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token invalide' });
  }
};

// Le compte .env (role 'admin') est traité comme un superadmin dans l'atelier
// → permet le bootstrap (créer les premiers comptes) sans compte en base.
const isSuperadmin = (role) => role === 'superadmin' || role === 'admin';

// ─────────────────────────────────────────────────────────────────────────────
// authorize(...roles) — restreint une route à certains rôles.
// Le superadmin (et le compte .env legacy) passe TOUJOURS.
//   ex: router.get('/x', authenticateUser, authorize('confirmatrice'), handler)
// ─────────────────────────────────────────────────────────────────────────────
const authorize = (...allowedRoles) => (req, res, next) => {
  const role = req.user?.role;
  if (!role) return res.status(401).json({ message: 'Non authentifié' });
  if (isSuperadmin(role) || allowedRoles.includes(role)) return next();
  return res.status(403).json({ message: 'Accès refusé pour votre rôle.' });
};

module.exports = { authenticateAdmin, authenticateUser, authorize, isSuperadmin };
