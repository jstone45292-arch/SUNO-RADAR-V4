const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get("/", (req, res) => {
  res.send("SUNO RADAR V4 RUNNING");
});

app.get("/radar", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("friends")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      return res.status(500).json(error);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
