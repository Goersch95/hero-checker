const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { checkBudget, recordGeneration } = require('./lib/expand-budget');

const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = process.env.PORT || 3000;

if (!APP_PASSWORD || !SESSION_SECRET) {
  console.error('APP_PASSWORD and SESSION_SECRET must be set');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(SESSION_SECRET));

function passwordMatches(candidate) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(APP_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (req.signedCookies.auth === 'ok') return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  const password = req.body.password;
  if (typeof password === 'string' && passwordMatches(password)) {
    res.cookie('auth', 'ok', {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  res.clearCookie('auth');
  res.redirect('/login');
});

// Generativ-Erweitern-Kontingent (Kill Switch): Phase 1 nutzt nur die kostenlose
// clientseitige Mock-Generierung, ruft aber schon jetzt diese Gates auf, damit in
// Phase 2 (echter Gemini-Call) keine Client-Änderung mehr nötig ist.
app.get('/qa/api/expand-budget', requireAuth, (req, res) => {
  res.json(checkBudget());
});

app.post('/qa/api/expand', requireAuth, (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    // Noch kein Key hinterlegt: kostenlose Mock-Generierung, verbraucht kein Budget
    // und wird daher NICHT gegen das Kontingent geprüft.
    return res.json({ mode: 'mock', ...checkBudget() });
  }
  // Ab hier entstehen echte Kosten -> Kill Switch greift.
  const budget = checkBudget();
  if (!budget.allowed) {
    return res.status(402).json({ error: 'budget_exceeded', ...budget });
  }
  // TODO Phase 2: echten Gemini-Outpainting-Call hier einbauen. Erst bei
  // tatsächlichem Erfolg recordGeneration() aufrufen (nicht vorher, nicht bei Fehlern).
  return res.status(501).json({ error: 'not_implemented' });
});

app.use(requireAuth, express.static(path.join(__dirname, 'protected')));
app.use('/qa', requireAuth, express.static(path.join(__dirname, 'protected-qa')));

app.listen(PORT, () => console.log(`listening on ${PORT}`));
