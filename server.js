require('dotenv').config();  // loads .env into process.env
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_KEY    = process.env.OMDB_API_KEY  || "1265beda";
const MONGO_URI  = process.env.MONGODB_URI;          // set in Render/Railway env vars
const DB_NAME    = process.env.DB_NAME || "screenbook";
const PORT       = process.env.PORT    || 3000;

// ─── MONGO CONNECTION ─────────────────────────────────────────────────────────
let db; // the mongodb database handle — populated once on startup

async function connectDB() {
  if (!MONGO_URI) {
    console.error("❌  MONGODB_URI env variable is not set!");
    console.error("    Set it in your .env file or hosting dashboard.");
    process.exit(1);
  }
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 45000,
  });
  await client.connect();
  db = client.db(DB_NAME);

  // Create indexes on first run (safe to call repeatedly — no-op if they exist)
  await db.collection("users").createIndex({ username: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ token: 1 }, { unique: true });
  await db.collection("sessions").createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 30 } // auto-delete sessions after 30 days
  );
  await db.collection("userData").createIndex({ userId: 1 }, { unique: true });

  console.log(`✅  MongoDB connected → ${DB_NAME}`);
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const session = await db.collection("sessions").findOne({ token });
    if (!session) return res.status(401).json({ error: "Invalid session" });
    req.userId = session.userId;
    req.username = session.username;
    next();
  } catch (err) {
    res.status(500).json({ error: "Auth check failed" });
  }
}

// ─── USER DATA HELPERS ────────────────────────────────────────────────────────
async function getUserData(userId) {
  let ud = await db.collection("userData").findOne({ userId });
  if (!ud) {
    ud = { userId, watchlist: [], watched: [], favorites: [], seriesProgress: {} };
    await db.collection("userData").insertOne(ud);
  }
  if (!ud.seriesProgress) {
    await db.collection("userData").updateOne({ userId }, { $set: { seriesProgress: {} } });
    ud.seriesProgress = {};
  }
  return ud;
}

async function saveUserData(userId, data) {
  // Remove the _id field before saving (Mongo adds it, can't update it)
  const { _id, ...update } = data;
  await db.collection("userData").updateOne(
    { userId },
    { $set: update },
    { upsert: true }
  );
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });
    if (password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });

    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const userId = crypto.randomBytes(8).toString("hex");

    await db.collection("users").insertOne({
      id: userId,
      username: username.trim(),
      email: email || "",
      passwordHash: hash,
      createdAt: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "Username already taken" });
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection("users").findOne({
      username: { $regex: new RegExp(`^${username.trim()}$`, "i") }
    });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const hash = crypto.createHash("sha256").update(password).digest("hex");
    if (hash !== user.passwordHash) return res.status(401).json({ error: "Invalid credentials" });

    const token = crypto.randomBytes(32).toString("hex");
    await db.collection("sessions").insertOne({
      token,
      userId: user.id,
      username: user.username,
      createdAt: new Date(),
    });

    res.json({ success: true, token, username: user.username, userId: user.id });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/logout", auth, async (req, res) => {
  try {
    const token = req.headers["x-auth-token"];
    await db.collection("sessions").deleteOne({ token });
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // logout always succeeds from client perspective
  }
});

app.get("/api/me", auth, (req, res) =>
  res.json({ userId: req.userId, username: req.username })
);

// ─── OMDB PROXY ROUTES ────────────────────────────────────────────────────────
app.get("/api/search", auth, async (req, res) => {
  try {
    const { q, page = 1, type = "", year = "" } = req.query;
    if (!q) return res.status(400).json({ error: "Query required" });
    let url = `https://www.omdbapi.com/?apikey=${API_KEY}&s=${encodeURIComponent(q)}&page=${page}`;
    if (type) url += `&type=${type}`;
    if (year) url += `&y=${year}`;
    const r = await axios.get(url, { timeout: 8000 });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Search failed", details: err.message });
  }
});

app.get("/api/movie/:id", auth, async (req, res) => {
  try {
    const r = await axios.get(
      `https://www.omdbapi.com/?apikey=${API_KEY}&i=${req.params.id}&plot=full`,
      { timeout: 8000 }
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch movie" });
  }
});

app.get("/api/series/:id/seasons", auth, async (req, res) => {
  try {
    const r = await axios.get(
      `https://www.omdbapi.com/?apikey=${API_KEY}&i=${req.params.id}&plot=short`,
      { timeout: 8000 }
    );
    const s = r.data;
    if (s.Response === "False") return res.status(404).json({ error: "Series not found" });
    res.json({ totalSeasons: parseInt(s.totalSeasons) || 1, title: s.Title, year: s.Year, poster: s.Poster, imdbRating: s.imdbRating });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch series info" });
  }
});

app.get("/api/series/:id/season/:season", auth, async (req, res) => {
  try {
    const r = await axios.get(
      `https://www.omdbapi.com/?apikey=${API_KEY}&i=${req.params.id}&Season=${req.params.season}`,
      { timeout: 8000 }
    );
    if (r.data.Response === "False") return res.status(404).json({ error: "Season not found" });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch season" });
  }
});

// ─── USER DATA ROUTES ─────────────────────────────────────────────────────────
app.get("/api/data", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    res.json(ud);
  } catch (err) {
    res.status(500).json({ error: "Failed to load data" });
  }
});

app.post("/api/watchlist", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    if (ud.watchlist.find(m => m.imdbID === req.body.imdbID))
      return res.status(409).json({ error: "Already in watchlist" });
    ud.watchlist.push({ ...req.body, addedAt: new Date().toISOString() });
    await saveUserData(req.userId, ud);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update watchlist" });
  }
});

app.delete("/api/watchlist/:id", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    ud.watchlist = ud.watchlist.filter(m => m.imdbID !== req.params.id);
    await saveUserData(req.userId, ud);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update watchlist" });
  }
});

app.post("/api/watched", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    ud.watchlist = ud.watchlist.filter(m => m.imdbID !== req.body.imdbID);
    const idx = ud.watched.findIndex(m => m.imdbID === req.body.imdbID);
    const entry = { ...req.body, watchedAt: new Date().toISOString() };
    if (idx !== -1) ud.watched[idx] = entry;
    else ud.watched.push(entry);
    await saveUserData(req.userId, ud);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save watched entry" });
  }
});

app.delete("/api/watched/:id", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    ud.watched = ud.watched.filter(m => m.imdbID !== req.params.id);
    await saveUserData(req.userId, ud);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove watched entry" });
  }
});

app.post("/api/favorites", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    if (!ud.favorites) ud.favorites = [];
    const idx = ud.favorites.findIndex(m => m.imdbID === req.body.imdbID);
    if (idx !== -1) {
      ud.favorites.splice(idx, 1);
      await saveUserData(req.userId, ud);
      return res.json({ success: true, favorited: false });
    }
    ud.favorites.push({ ...req.body, favoritedAt: new Date().toISOString() });
    await saveUserData(req.userId, ud);
    res.json({ success: true, favorited: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update favorites" });
  }
});

// ─── SERIES PROGRESS ─────────────────────────────────────────────────────────
app.get("/api/series-progress", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    res.json({ seriesProgress: ud.seriesProgress || {} });
  } catch (err) {
    res.status(500).json({ error: "Failed to load series progress" });
  }
});

app.get("/api/series-progress/:id", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    res.json({ progress: ud.seriesProgress?.[req.params.id] || null });
  } catch (err) {
    res.status(500).json({ error: "Failed to load series progress" });
  }
});

app.post("/api/series-progress/:id", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    if (!ud.seriesProgress) ud.seriesProgress = {};
    const existing = ud.seriesProgress[req.params.id] || {};
    ud.seriesProgress[req.params.id] = {
      ...existing,
      ...req.body.seriesInfo,
      imdbID: req.params.id,
      currentSeason: req.body.season,
      currentEpisode: req.body.episode,
      currentEpisodeTitle: req.body.episodeTitle || "",
      status: req.body.status || "watching",
      updatedAt: new Date().toISOString(),
      startedAt: existing.startedAt || new Date().toISOString(),
    };
    await saveUserData(req.userId, ud);
    res.json({ success: true, progress: ud.seriesProgress[req.params.id] });
  } catch (err) {
    res.status(500).json({ error: "Failed to save series progress" });
  }
});

app.post("/api/series-progress/:id/episode", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    if (!ud.seriesProgress?.[req.params.id])
      return res.status(404).json({ error: "Series not tracked yet" });
    const prog = ud.seriesProgress[req.params.id];
    if (!prog.episodes) prog.episodes = {};
    const key = `S${req.body.season}E${req.body.episode}`;
    if (req.body.watched) {
      prog.episodes[key] = { season: req.body.season, episode: req.body.episode, title: req.body.episodeTitle || "", watchedAt: new Date().toISOString() };
    } else {
      delete prog.episodes[key];
    }
    prog.updatedAt = new Date().toISOString();
    await saveUserData(req.userId, ud);
    res.json({ success: true, episodes: prog.episodes });
  } catch (err) {
    res.status(500).json({ error: "Failed to update episode" });
  }
});

app.delete("/api/series-progress/:id", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    if (ud.seriesProgress) delete ud.seriesProgress[req.params.id];
    await saveUserData(req.userId, ud);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove series" });
  }
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get("/api/stats", auth, async (req, res) => {
  try {
    const ud = await getUserData(req.userId);
    const watched = ud.watched || [];
    const rated = watched.filter(m => m.userRating);
    const avgRating = rated.length
      ? (rated.reduce((s, m) => s + parseFloat(m.userRating), 0) / rated.length).toFixed(1)
      : 0;
    const genreCount = {};
    watched.forEach(m => (m.Genre || "").split(", ").forEach(g => { if (g) genreCount[g] = (genreCount[g] || 0) + 1; }));
    const ratingDist = { "1-3": 0, "4-5": 0, "6-7": 0, "8-9": 0, "10": 0 };
    watched.forEach(m => {
      const r = parseFloat(m.userRating); if (!r) return;
      if (r <= 3) ratingDist["1-3"]++; else if (r <= 5) ratingDist["4-5"]++;
      else if (r <= 7) ratingDist["6-7"]++; else if (r <= 9) ratingDist["8-9"]++; else ratingDist["10"]++;
    });
    const monthCount = {};
    watched.forEach(m => { if (m.watchDate) { const mo = m.watchDate.substring(0, 7); monthCount[mo] = (monthCount[mo] || 0) + 1; } });
    const sp = ud.seriesProgress || {};

    res.json({
      totalWatched: watched.length,
      totalWatchlist: (ud.watchlist || []).length,
      totalFavorites: (ud.favorites || []).length,
      avgRating, genreCount, ratingDist, monthCount,
      totalTracked: Object.keys(sp).length,
      totalEpsWatched: Object.values(sp).reduce((s, p) => s + Object.keys(p.episodes || {}).length, 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", db: !!db }));

// ─── START ────────────────────────────────────────────────────────────────────
connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🎬  ScreenBook running → http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error("❌  Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });