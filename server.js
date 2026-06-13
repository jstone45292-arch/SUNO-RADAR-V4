const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const app = express();

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

async function scanOnce() {
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
  res.send("SUNO RADAR ACTIVE");
});

app.get("/friends", async (req, res) => {
  const { data, error } = await supabase.from("friends").select("*");
  if (error) return res.status(500).json(error);
  res.json(data);
});

app.get("/tracks", async (req, res) => {
  const { data, error } = await supabase
    .from("tracks")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json(error);
  res.json(data);
});

app.get("/scan", async (req, res) => {
  try {
    const result = await scanOnce();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

cron.schedule("0 * * * *", async () => {
  console.log("auto scan start");
  await scanOnce();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
