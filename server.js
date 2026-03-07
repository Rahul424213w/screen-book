const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const API_KEY = process.env.OMDB_API_KEY || "1265beda";
const DB_FILE = path.join(__dirname, "database.json");

// ─── DB ───────────────────────────────────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], sessions: {}, userData: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function getUserData(userId) {
  const db = readDB();
  if (!db.userData) db.userData = {};
  if (!db.userData[userId]) {
    db.userData[userId] = { watchlist: [], watched: [], favorites: [], seriesProgress: {} };
    writeDB(db);
  }
  if (!db.userData[userId].seriesProgress) {
    db.userData[userId].seriesProgress = {};
    writeDB(db);
  }
  return db.userData[userId];
}
function saveUserData(userId, userData) {
  const db = readDB();
  if (!db.userData) db.userData = {};
  db.userData[userId] = userData;
  writeDB(db);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const db = readDB();
  const session = db.sessions?.[token];
  if (!session) return res.status(401).json({ error: "Invalid session" });
  req.userId = session.userId;
  req.username = session.username;
  next();
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post("/api/register", (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  const db = readDB();
  if (!db.users) db.users = [];
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: "Username already taken" });
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  const userId = crypto.randomBytes(8).toString("hex");
  db.users.push({ id: userId, username, email: email || "", passwordHash: hash, createdAt: new Date().toISOString() });
  writeDB(db);
  res.json({ success: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const user = db.users?.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  if (hash !== user.passwordHash) return res.status(401).json({ error: "Invalid credentials" });
  const token = crypto.randomBytes(32).toString("hex");
  if (!db.sessions) db.sessions = {};
  db.sessions[token] = { userId: user.id, username: user.username, createdAt: new Date().toISOString() };
  writeDB(db);
  res.json({ success: true, token, username: user.username, userId: user.id });
});

app.post("/api/logout", auth, (req, res) => {
  const token = req.headers["x-auth-token"];
  const db = readDB();
  delete db.sessions[token];
  writeDB(db);
  res.json({ success: true });
});

app.get("/api/me", auth, (req, res) => res.json({ userId: req.userId, username: req.username }));

// ─── OMDB ROUTES ──────────────────────────────────────────────────────────────
app.get("/api/search", auth, async (req, res) => {
  try {
    const { q, page = 1, type = "", year = "" } = req.query;
    let url = `https://www.omdbapi.com/?apikey=${API_KEY}&s=${encodeURIComponent(q)}&page=${page}`;
    if (type) url += `&type=${type}`;
    if (year) url += `&y=${year}`;
    const r = await axios.get(url);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Search failed", details: err.message });
  }
});

app.get("/api/movie/:id", auth, async (req, res) => {
  try {
    const r = await axios.get(`https://www.omdbapi.com/?apikey=${API_KEY}&i=${req.params.id}&plot=full`);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch movie" });
  }
});

// Get seasons list for a series
app.get("/api/series/:id/seasons", auth, async (req, res) => {
  try {
    // First get the series info to know total seasons
    const seriesRes = await axios.get(`https://www.omdbapi.com/?apikey=${API_KEY}&i=${req.params.id}&plot=short`);
    const series = seriesRes.data;
    if (series.Response === "False") return res.status(404).json({ error: "Series not found" });

    const totalSeasons = parseInt(series.totalSeasons) || 1;
    res.json({ totalSeasons, title: series.Title, year: series.Year, poster: series.Poster, imdbRating: series.imdbRating });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch series info" });
  }
});

// Get episodes for a specific season
app.get("/api/series/:id/season/:season", auth, async (req, res) => {
  try {
    const r = await axios.get(
      `https://www.omdbapi.com/?apikey=${API_KEY}&i=${req.params.id}&Season=${req.params.season}`
    );
    if (r.data.Response === "False") return res.status(404).json({ error: "Season not found" });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch season" });
  }
});

// ─── USER DATA ────────────────────────────────────────────────────────────────
app.get("/api/data", auth, (req, res) => res.json(getUserData(req.userId)));

app.post("/api/watchlist", auth, (req, res) => {
  const ud = getUserData(req.userId);
  if (ud.watchlist.find(m => m.imdbID === req.body.imdbID))
    return res.status(409).json({ error: "Already in watchlist" });
  ud.watchlist.push({ ...req.body, addedAt: new Date().toISOString() });
  saveUserData(req.userId, ud);
  res.json({ success: true });
});

app.delete("/api/watchlist/:id", auth, (req, res) => {
  const ud = getUserData(req.userId);
  ud.watchlist = ud.watchlist.filter(m => m.imdbID !== req.params.id);
  saveUserData(req.userId, ud);
  res.json({ success: true });
});

app.post("/api/watched", auth, (req, res) => {
  const ud = getUserData(req.userId);
  ud.watchlist = ud.watchlist.filter(m => m.imdbID !== req.body.imdbID);
  const idx = ud.watched.findIndex(m => m.imdbID === req.body.imdbID);
  const entry = { ...req.body, watchedAt: new Date().toISOString() };
  if (idx !== -1) ud.watched[idx] = entry;
  else ud.watched.push(entry);
  saveUserData(req.userId, ud);
  res.json({ success: true });
});

app.delete("/api/watched/:id", auth, (req, res) => {
  const ud = getUserData(req.userId);
  ud.watched = ud.watched.filter(m => m.imdbID !== req.params.id);
  saveUserData(req.userId, ud);
  res.json({ success: true });
});

app.post("/api/favorites", auth, (req, res) => {
  const ud = getUserData(req.userId);
  if (!ud.favorites) ud.favorites = [];
  const idx = ud.favorites.findIndex(m => m.imdbID === req.body.imdbID);
  if (idx !== -1) {
    ud.favorites.splice(idx, 1);
    saveUserData(req.userId, ud);
    return res.json({ success: true, favorited: false });
  }
  ud.favorites.push({ ...req.body, favoritedAt: new Date().toISOString() });
  saveUserData(req.userId, ud);
  res.json({ success: true, favorited: true });
});

// ─── SERIES PROGRESS ─────────────────────────────────────────────────────────
// Get progress for one series
app.get("/api/series-progress/:id", auth, (req, res) => {
  const ud = getUserData(req.userId);
  const progress = ud.seriesProgress?.[req.params.id] || null;
  res.json({ progress });
});

// Save/update series progress
// Body: { seriesInfo, season, episode, episodeTitle, status }
// status: "watching" | "completed" | "paused" | "dropped"
app.post("/api/series-progress/:id", auth, (req, res) => {
  const ud = getUserData(req.userId);
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
  saveUserData(req.userId, ud);
  res.json({ success: true, progress: ud.seriesProgress[req.params.id] });
});

// Mark specific episode as watched/unwatched
// Body: { season, episode, watched: true/false, episodeTitle }
app.post("/api/series-progress/:id/episode", auth, (req, res) => {
  const ud = getUserData(req.userId);
  if (!ud.seriesProgress) ud.seriesProgress = {};
  if (!ud.seriesProgress[req.params.id]) {
    return res.status(404).json({ error: "Series not tracked yet. Add it first." });
  }
  const prog = ud.seriesProgress[req.params.id];
  if (!prog.episodes) prog.episodes = {};
  const key = `S${req.body.season}E${req.body.episode}`;
  if (req.body.watched) {
    prog.episodes[key] = {
      season: req.body.season,
      episode: req.body.episode,
      title: req.body.episodeTitle || "",
      watchedAt: new Date().toISOString(),
    };
  } else {
    delete prog.episodes[key];
  }
  prog.updatedAt = new Date().toISOString();
  saveUserData(req.userId, ud);
  res.json({ success: true, episodes: prog.episodes });
});

// Delete series progress entirely
app.delete("/api/series-progress/:id", auth, (req, res) => {
  const ud = getUserData(req.userId);
  if (ud.seriesProgress) delete ud.seriesProgress[req.params.id];
  saveUserData(req.userId, ud);
  res.json({ success: true });
});

// Get all series being tracked
app.get("/api/series-progress", auth, (req, res) => {
  const ud = getUserData(req.userId);
  res.json({ seriesProgress: ud.seriesProgress || {} });
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get("/api/stats", auth, (req, res) => {
  const ud = getUserData(req.userId);
  const watched = ud.watched || [];
  const totalWatched = watched.length;
  const rated = watched.filter(m => m.userRating);
  const avgRating = rated.length ? (rated.reduce((s, m) => s + parseFloat(m.userRating), 0) / rated.length).toFixed(1) : 0;
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

  // Series stats
  const sp = ud.seriesProgress || {};
  const totalTracked = Object.keys(sp).length;
  const totalEpsWatched = Object.values(sp).reduce((s, p) => s + Object.keys(p.episodes || {}).length, 0);

  res.json({
    totalWatched, totalWatchlist: (ud.watchlist || []).length,
    totalFavorites: (ud.favorites || []).length, avgRating,
    genreCount, ratingDist, monthCount,
    totalTracked, totalEpsWatched
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 ScreenBook running at http://localhost:${PORT}`));