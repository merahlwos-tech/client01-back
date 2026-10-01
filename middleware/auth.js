// middleware/auth.js
const jwt = require('jsonwebtoken');

/* ═══════════════════════════════════════════════════════════════════════════
   ⚠️  ACCÈS LIBRE À L'ATELIER — SÉCURITÉ DÉSACTIVÉE
   ───────────────────────────────────────────────────────────────────────────
   Quand OPEN_ACCESS vaut true, toutes les routes /api/workflow, /api/stock et
   /api/users sont accessibles SANS identifiant ni mot de passe : n'importe qui
   sur Internet peut lire les coordonnées des clients et modifier les commandes.

   👉 POUR RÉACTIVER LA SÉCURITÉ : mettre `false` ci-dessous (ou définir la
      variable d'environnement STAFF_OPEN_ACCESS=false sur Render).

   Le panneau e-commerce /admin reste protégé dans tous les cas.
   ═══════════════════════════════════════════════════════════════════════════ */
const OPEN_ACCESS = process.env.STAFF_OPEN_ACCESS !== 'false';

// Identité attribuée aux visiteurs quand l'accès est libre.
// `openAccess: true` permet de distinguer ce visiteur d'un vrai superadmin :
// il obtient l'ACCÈS aux pages, mais pas le droit de passer outre les
// garde-fous métier (modifier une commande déjà fabriquée, sauter une étape…).
const GUEST_USER = { username: 'acces-libre', role: 'superadmin', openAccess: true };

if (OPEN_ACCESS) {
  console.warn('⚠️  ATELIER EN ACCÈS LIBRE — aucune authentification requise sur /api/workflow et /api/stock (la gestion des comptes reste protégée)');
}

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
  // Accès libre : on attribue une identité invité et on laisse passer
  if (OPEN_ACCESS) {
    req.user = { ...GUEST_USER };
    return next();
  }

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
  if (OPEN_ACCESS) return next();   // accès libre : aucune restriction de rôle

  const role = req.user?.role;
  if (!role) return res.status(401).json({ message: 'Non authentifié' });
  if (isSuperadmin(role) || allowedRoles.includes(role)) return next();
  return res.status(403).json({ message: 'Accès refusé pour votre rôle.' });
};

// ─────────────────────────────────────────────────────────────────────────────
// GESTION DES COMPTES — exige un VRAI jeton superadmin, même en accès libre.
//
// L'accès libre ouvre l'atelier, pas les clés du site : sans ce contrôle, un
// inconnu pouvait créer un compte superadmin, se connecter avec, et obtenir
// un jeton accepté par tout le panneau /admin e-commerce (commandes, données
// clients, suppressions). Créer ou modifier un compte n'a jamais besoin
// d'être anonyme.
// ─────────────────────────────────────────────────────────────────────────────
const requireRealSuperadmin = (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({
        message: 'Connectez-vous avec le compte propriétaire pour gérer les comptes.',
      });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!isSuperadmin(decoded.role)) {
      return res.status(403).json({ message: 'Réservé au superadmin.' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token invalide' });
  }
};

module.exports = {
  authenticateAdmin, authenticateUser, authorize, requireRealSuperadmin, isSuperadmin, OPEN_ACCESS,
};
