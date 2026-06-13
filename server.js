const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get("/", async (req, res) => {
  res.send("SUNO RADAR ACTIVE");
});

app.get("/friends", async (req, res) => {
  const { data, error } = await supabase
    .from("friends")
    .select("*");

  if (error) {
    return res.status(500).json(error);
  }

  res.json(data);
});

app.get("/tracks", async (req, res) => {
  const { data, error } = await supabase
    .from("tracks")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json(error);
  }

  res.json(data);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
