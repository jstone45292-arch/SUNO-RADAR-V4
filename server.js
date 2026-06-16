const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.static("."));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const headers = {
  "User-Agent": "Mozilla/5.0"
};

function extractSongIds(html) {
  const ids = new Set();
  const re = /\/song\/([a-f0-9-]{36})/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

async function getSongTitle(songUrl) {
  try {
    const { data } = await axios.get(songUrl, { headers, timeout: 15000 });
    const og = data.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (og) return og[1].replace(" | Suno", "").trim();
  } catch {}
  return "Suno song";
}

async function cleanupTracks() {
  const now = new Date();
  const readLimit = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const archiveLimit = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error: archiveError } = await supabase
    .from("tracks")
    .update({ state: "ARCHIVED", archived_at: now.toISOString() })
    .eq("state", "READ")
    .lt("read_at", readLimit);

  const { error: deleteError } = await supabase
    .from("tracks")
    .delete()
    .eq("state", "ARCHIVED")
    .lt("archived_at", archiveLimit);

  return {
    ok: !archiveError && !deleteError,
    archiveError: archiveError ? archiveError.message : null,
    deleteError: deleteError ? deleteError.message : null
  };
}

async function scanOnce() {
  await cleanupTracks();

  const { data: friends, error } = await supabase
    .from("friends")
    .select("*")
    .eq("active", true);

  if (error) throw error;

  let inserted = 0;

  for (const friend of friends) {
    try {
      const { data: html } = await axios.get(friend.profile_url, { headers, timeout: 20000 });
      const ids = extractSongIds(html).slice(0, 3);

      for (const id of ids) {
        const trackUrl = `https://suno.com/song/${id}`;
        const title = await getSongTitle(trackUrl);

        const { error: insertError } = await supabase
          .from("tracks")
          .upsert({
            track_key: id,
            friend_name: friend.friend_name,
            title,
            track_url: trackUrl,
            profile_url: friend.profile_url,
            group_name: friend.group_name,
            state: "NEW",
            detected_at: new Date().toISOString()
          }, {
            onConflict: "track_key",
            ignoreDuplicates: true
          });

        if (!insertError) inserted++;
      }
    } catch (e) {
      console.log("scan fail:", friend.friend_name, e.message);
    }
  }

  return { ok: true, friends: friends.length, inserted };
}

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/friends", async (req, res) => {
  const { data, error } = await supabase
    .from("friends")
    .select("*")
    .order("id", { ascending: true });

  if (error) return res.status(500).json(error);
  res.json(data);
});

app.get("/friend-search", async (req, res) => {
  const keyword = req.query.q || "";

  const { data, error } = await supabase
    .from("friends")
    .select("*")
    .ilike("friend_name", `%${keyword}%`)
    .order("friend_name");

  if (error) return res.status(500).json(error);
  res.json(data);
});

app.get("/tracks", async (req, res) => {
  let query = supabase
    .from("tracks")
    .select("*")
    .order("created_at", { ascending: false });

  if (req.query.state) {
    query = query.eq("state", req.query.state);
  }

  const { data, error } = await query;

  if (error) return res.status(500).json(error);
  res.json(data);
});

app.get("/mark-read/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("tracks")
    .update({
      state: "READ",
      read_at: new Date().toISOString()
    })
    .eq("id", req.params.id)
    .select();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, data });
});

app.get("/add-friend", async (req, res) => {
  const { friend_name, profile_url, group_name } = req.query;

  if (!friend_name || !profile_url) {
    return res.status(400).json({
      ok: false,
      error: "friend_name/profile_url required"
    });
  }

  const { data, error } = await supabase
    .from("friends")
    .insert({
      friend_name,
      profile_url,
      group_name: group_name || "한국",
      active: true
    })
    .select();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, friend: data });
});

app.get("/delete-friend/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("friends")
    .delete()
    .eq("id", req.params.id)
    .select();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, deleted: data });
});

app.get("/toggle-friend/:id", async (req, res) => {
  const { data: current, error: readError } = await supabase
    .from("friends")
    .select("active")
    .eq("id", req.params.id)
    .single();

  if (readError) return res.status(500).json({ ok: false, error: readError.message });

  const { data, error } = await supabase
    .from("friends")
    .update({ active: !current.active })
    .eq("id", req.params.id)
    .select();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  res.json({ ok: true, friend: data });
});

app.get("/stats", async (req, res) => {
  const { count: newCount } = await supabase
    .from("tracks")
    .select("*", { count: "exact", head: true })
    .eq("state", "NEW");

  const { count: readCount } = await supabase
    .from("tracks")
    .select("*", { count: "exact", head: true })
    .eq("state", "READ");

  const { count: archiveCount } = await supabase
    .from("tracks")
    .select("*", { count: "exact", head: true })
    .eq("state", "ARCHIVED");

  const { count: friendCount } = await supabase
    .from("friends")
    .select("*", { count: "exact", head: true })
    .eq("active", true);

  res.json({
    new: newCount || 0,
    read: readCount || 0,
    archived: archiveCount || 0,
    friends: friendCount || 0
  });
});

app.get("/latest", async (req, res) => {
  const { data, error } = await supabase
    .from("tracks")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json(error);
  res.json(data);
});

app.get("/cleanup", async (req, res) => {
  const result = await cleanupTracks();
  res.json(result);
});

app.get("/scan", async (req, res) => {
  try {
    const result = await scanOnce();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

cron.schedule("*/10 * * * *", async () => {
  console.log("auto scan start");
  await scanOnce();
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
Commit changes
