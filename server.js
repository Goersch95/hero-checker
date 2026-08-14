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

// Generativ-Erweitern-Kontingent (Kill Switch).
app.get('/qa/api/expand-budget', requireAuth, (req, res) => {
  res.json(checkBudget());
});

const GEMINI_API_BASE = process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com';
const GEMINI_MODEL = process.env.GEMINI_EXPAND_MODEL || 'gemini-2.5-flash-image';
const EXPAND_PROMPT = 'Extend this image beyond its original borders using outpainting. The sharp, '
  + 'in-focus area in the middle is the original photo - keep its subject and composition completely '
  + 'intact and unchanged. The blurred area around it is a rough placeholder showing roughly where the '
  + 'scene continues; replace ONLY that blurred area with new, photorealistic, high-resolution, '
  + 'seamlessly integrated content that matches the style, colors, lighting and perspective of the '
  + 'original photo exactly, as if the camera had simply captured a wider shot. Do not add any text, '
  + 'logos, watermarks, or new people. 16:9 landscape output.';

// Verhindert, dass zwei nahezu gleichzeitige Anfragen beide den Budget-Check bestehen,
// bevor die erste ihren Verbrauch verbucht hat (einfache Serialisierung reicht für dieses
// kleine, intern genutzte Tool - keine Mehrprozess-Deployments).
let expandQueue = Promise.resolve();
function serialize(fn) {
  const run = expandQueue.then(fn, fn);
  expandQueue = run.catch(() => {});
  return run;
}

app.post('/qa/api/expand', requireAuth, express.json({ limit: '20mb' }), (req, res) => {
  serialize(() => handleExpand(req, res)).catch(err => {
    console.error('Unerwarteter Fehler bei /qa/api/expand:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

async function handleExpand(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    // Noch kein Key hinterlegt: kostenlose Mock-Generierung, verbraucht kein Budget
    // und wird daher NICHT gegen das Kontingent geprüft.
    return res.json({ mode: 'mock', ...checkBudget() });
  }

  const image = req.body && req.body.image;
  const match = typeof image === 'string' && image.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: 'bad_request', message: 'Erwarte ein Bild als data-URL im Feld "image".' });
  }
  const [, mimeType, base64Data] = match;

  // Ab hier würde ein echter Call Kosten verursachen -> Kill Switch greift VOR dem Call.
  const budget = checkBudget();
  if (!budget.allowed) {
    return res.status(402).json({ error: 'budget_exceeded', ...budget });
  }

  let geminiRes;
  try {
    geminiRes = await fetch(
      `${GEMINI_API_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: EXPAND_PROMPT }, { inlineData: { mimeType, data: base64Data } }] }],
          // Ohne explizites aspectRatio fällt das Modell laut Doku auf 1:1 zurück, obwohl
          // unser Canvas fix 3840x2160 (16:9) ist - dieser Widerspruch zur "an dieser Stelle
          // bearbeiten, Rest beibehalten"-Anweisung im Prompt ist ein plausibler Auslöser
          // für das generische finishReason=IMAGE_OTHER.
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } },
        }),
      }
    );
  } catch (err) {
    console.error('Gemini-Aufruf fehlgeschlagen (Netzwerk):', err);
    return res.status(502).json({ error: 'provider_error', message: 'Verbindung zum KI-Anbieter fehlgeschlagen.' });
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    console.error('Gemini-Aufruf fehlgeschlagen:', geminiRes.status, errText.slice(0, 500));
    // Internes, passwortgeschütztes QA-Tool: die echte Provider-Fehlermeldung direkt
    // zeigen spart das Nachschauen in den Coolify-Logs bei jedem Debugging-Schritt.
    let providerMessage = null;
    try { providerMessage = JSON.parse(errText).error?.message; } catch (_) {}
    return res.status(502).json({
      error: 'provider_error',
      message: `KI-Anbieter hat die Anfrage abgelehnt (HTTP ${geminiRes.status}): ${providerMessage || errText.slice(0, 300) || 'unbekannter Fehler'}`,
    });
  }

  const data = await geminiRes.json().catch(() => null);
  const candidate = data && data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
  if (!imgPart) {
    console.error('Gemini-Antwort enthielt kein Bild:', JSON.stringify(data).slice(0, 500));
    const textPart = parts.find(p => typeof p.text === 'string');
    const reasonBits = [
      candidate && candidate.finishReason ? `finishReason: ${candidate.finishReason}` : null,
      textPart ? `Modell-Antwort: "${textPart.text.slice(0, 200)}"` : null,
    ].filter(Boolean);
    return res.status(502).json({
      error: 'provider_error',
      message: 'Kein Bild in der Antwort erhalten.' + (reasonBits.length ? ' (' + reasonBits.join(', ') + ')' : ''),
    });
  }

  // Erst JETZT, nach bestätigtem Erfolg, gegen das Budget verbuchen.
  const budgetAfter = recordGeneration();
  return res.json({
    mode: 'real',
    image: `data:${imgPart.inlineData.mimeType || 'image/png'};base64,${imgPart.inlineData.data}`,
    ...budgetAfter,
  });
}

app.use(requireAuth, express.static(path.join(__dirname, 'protected')));
app.use('/qa', requireAuth, express.static(path.join(__dirname, 'protected-qa')));

app.listen(PORT, () => console.log(`listening on ${PORT}`));
